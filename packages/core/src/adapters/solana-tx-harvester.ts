/**
 * Solana Transaction Harvester — indexes agent wallet activity via Helius Enhanced Transactions API.
 *
 * Helius pre-classifies transactions (SWAP, TRANSFER, NFT_SALE, etc.) so no swap
 * reconstruction is needed. Token metadata is included in the response.
 *
 * Per-wallet pagination using Solana transaction signatures.
 * Processes wallets in round-robin batches for scalability.
 */
import type pg from 'pg'
import { TokenRegistry } from './token-registry.js'

export interface SolanaTxHarvesterConfig {
  intervalMs: number
  walletsPerCycle: number
  heliusApiKey: string
}

const DEFAULT_CONFIG: SolanaTxHarvesterConfig = {
  intervalMs: 60_000,
  walletsPerCycle: 50,
  heliusApiKey: '',
}

const CHECKPOINT_KEY = 'solana_tx_harvester'

interface HeliusTransaction {
  signature: string
  timestamp: number
  type: string // SWAP, TRANSFER, NFT_SALE, etc.
  source: string // JUPITER, RAYDIUM, ORCA, UNKNOWN, etc.
  tokenTransfers?: Array<{
    fromUserAccount: string
    toUserAccount: string
    mint: string
    tokenAmount: number
    tokenStandard?: string
  }>
  nativeTransfers?: Array<{
    fromUserAccount: string
    toUserAccount: string
    amount: number // lamports
  }>
}

export async function harvestSolanaTransactions(
  pool: pg.Pool,
  config: SolanaTxHarvesterConfig,
  tokenRegistry: TokenRegistry,
): Promise<number> {
  if (!config.heliusApiKey) return 0

  const client = await pool.connect()
  let harvested = 0

  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('solana_tx_harvester'))")
    if (!lockResult.rows[0].pg_try_advisory_lock) {
      return 0 // finally block handles client.release()
    }

    // Load Solana wallets
    const walletsResult = await client.query(
      "SELECT DISTINCT address, agent_entity FROM oracle_wallet_mappings WHERE chain = 'solana' AND removed_at IS NULL",
    )
    if (walletsResult.rows.length === 0) {
      await client.query("SELECT pg_advisory_unlock(hashtext('solana_tx_harvester'))")
      return 0 // finally block handles client.release()
    }

    // Load per-wallet cursors
    const cpResult = await client.query("SELECT last_seen_id FROM oracle_worker_checkpoints WHERE source_table = $1", [CHECKPOINT_KEY])
    const cursors: Record<string, string> = cpResult.rows.length > 0
      ? JSON.parse(cpResult.rows[0].last_seen_id as string)
      : {}

    // Round-robin: pick next batch of wallets
    const allWallets = walletsResult.rows
    const walletMap = new Map<string, string>()
    for (const row of allWallets) walletMap.set(row.address, row.agent_entity as string)

    // Sort by least-recently-polled (wallets not in cursors first)
    const sorted = allWallets.sort((a, b) => {
      const aHas = cursors[a.address] ? 1 : 0
      const bHas = cursors[b.address] ? 1 : 0
      return aHas - bHas
    })

    const batch = sorted.slice(0, config.walletsPerCycle)

    for (const wallet of batch) {
      const address = wallet.address as string
      const entityId = wallet.agent_entity as string
      const lastSig = cursors[address]

      try {
        const txs = await fetchHeliusTransactions(config.heliusApiKey, address, lastSig)
        if (txs.length === 0) continue

        for (const tx of txs) {
          const timestamp = new Date(tx.timestamp * 1000).toISOString()
          // Helius pre-classifies — higher confidence than EVM heuristics
          const txType = tx.type === 'SWAP' ? 'swap' : 'transfer'
          const classConfidence = 'high' // Helius classification is reliable
          const swapGroupId = tx.type === 'SWAP' ? tx.signature : null

          // Process token transfers
          if (tx.tokenTransfers) {
            for (let i = 0; i < tx.tokenTransfers.length; i++) {
              const t = tx.tokenTransfers[i]
              const isOutbound = t.fromUserAccount.toLowerCase() === address.toLowerCase()
              const isInbound = t.toUserAccount.toLowerCase() === address.toLowerCase()
              if (!isOutbound && !isInbound) continue

              const direction = isOutbound ? 'outbound' : 'inbound'
              const counterparty = isOutbound ? t.toUserAccount : t.fromUserAccount

              // Resolve token
              const token = tokenRegistry.lookup('solana', t.mint)
              const rawAmount = String(Math.round(t.tokenAmount * Math.pow(10, token?.decimals ?? 9)))

              const usdVal = tokenRegistry.getUsdValue('solana', t.mint, rawAmount)
              const valConf = token?.isStablecoin ? 'exact' : (usdVal != null ? 'medium' : 'none')

              await client.query(
                `INSERT INTO oracle_wallet_transactions
                 (agent_entity, chain, wallet_address, tx_hash, block_number, log_index, direction, counterparty,
                  token_address, token_symbol, token_decimals, amount, amount_usd, event_timestamp,
                  tx_type, swap_group_id, classification_confidence, valuation_confidence)
                 VALUES ($1, 'solana', $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                 ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
                [entityId, address, tx.signature, i, direction, counterparty,
                 t.mint, token?.symbol ?? null, token?.decimals ?? null, rawAmount, usdVal,
                 timestamp, txType, swapGroupId, classConfidence, valConf],
              )
              harvested++
            }
          }

          // Process native SOL transfers
          if (tx.nativeTransfers) {
            for (let i = 0; i < tx.nativeTransfers.length; i++) {
              const t = tx.nativeTransfers[i]
              const isOutbound = t.fromUserAccount.toLowerCase() === address.toLowerCase()
              const isInbound = t.toUserAccount.toLowerCase() === address.toLowerCase()
              if (!isOutbound && !isInbound) continue
              if (t.amount === 0) continue

              const direction = isOutbound ? 'outbound' : 'inbound'
              const counterparty = isOutbound ? t.toUserAccount : t.fromUserAccount
              const logIndex = 10000 + i // offset to avoid collision with tokenTransfers

              await client.query(
                `INSERT INTO oracle_wallet_transactions
                 (agent_entity, chain, wallet_address, tx_hash, block_number, log_index, direction, counterparty,
                  token_address, token_symbol, token_decimals, amount, event_timestamp, tx_type, swap_group_id)
                 VALUES ($1, 'solana', $2, $3, 0, $4, $5, $6, 'So11111111111111111111111111111111111111112', 'SOL', 9, $7, $8, $9, $10)
                 ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
                [entityId, address, tx.signature, logIndex, direction, counterparty,
                 String(t.amount), timestamp, txType, swapGroupId],
              )
              harvested++
            }
          }
        }

        // Update cursor to latest signature
        if (txs.length > 0) {
          cursors[address] = txs[0].signature // Helius returns newest first
        }
      } catch (err) {
        console.error(`[solana-harvester] Error for ${address.slice(0, 8)}:`, (err as Error).message)
      }

      // Rate limiting: 200ms between wallets
      await new Promise((r) => setTimeout(r, 200))
    }

    // Save cursors
    await client.query(
      `INSERT INTO oracle_worker_checkpoints (source_table, watermark_column, last_seen_ts, last_seen_id, updated_at)
       VALUES ($1, 'created_at', now(), $2, now())
       ON CONFLICT (source_table) DO UPDATE SET last_seen_id = $2, last_seen_ts = now(), updated_at = now()`,
      [CHECKPOINT_KEY, JSON.stringify(cursors)],
    )

    await client.query("SELECT pg_advisory_unlock(hashtext('solana_tx_harvester'))")
  } finally {
    client.release()
  }

  return harvested
}

async function fetchHeliusTransactions(
  apiKey: string,
  address: string,
  beforeSignature?: string,
): Promise<HeliusTransaction[]> {
  let url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=50`
  if (beforeSignature) url += `&before=${beforeSignature}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return []
    return (await res.json()) as HeliusTransaction[]
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start the Solana transaction harvester on a timer.
 */
export function startSolanaTxHarvester(
  pool: pg.Pool,
  config: Partial<SolanaTxHarvesterConfig> & { heliusApiKey: string },
): { stop: () => void } {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const tokenRegistry = new TokenRegistry()
  let running = true

  const loop = async () => {
    await tokenRegistry.loadFromDb(pool)
    while (running) {
      try {
        const n = await harvestSolanaTransactions(pool, fullConfig, tokenRegistry)
        if (n > 0) console.log(`[solana-harvester] Harvested ${n} Solana transfers`)
      } catch (err) {
        console.error('[solana-harvester] Error:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, fullConfig.intervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
