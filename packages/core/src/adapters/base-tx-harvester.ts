/**
 * Base Transaction Harvester — indexes ALL ERC-20 transfers to/from agent wallets.
 *
 * Architecture (Nansen/Arkham pattern):
 *   1. Query eth_getLogs with NO address filter (catches all ERC-20 contracts)
 *   2. Filter by topic[1] or topic[2] = agent wallet addresses
 *   3. Insert raw transfers into oracle_wallet_transactions
 *   4. Post-process: group by tx_hash to reconstruct DEX swaps
 *   5. Resolve unknown tokens via TokenRegistry
 *
 * Checkpointed, idempotent, advisory-locked. Scales to 50,000+ wallets.
 */
import type pg from 'pg'
import { TokenRegistry } from './token-registry.js'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const CHECKPOINT_KEY = 'base_tx_harvester'
const ZERO_ADDRESS = '0x' + '0'.repeat(40)
const STABLECOIN_SYMBOLS = ['USDC', 'USDT', 'DAI', 'USDbC'] as const

export interface TxHarvesterConfig {
  intervalMs: number
  blockBatchSize: number
  rpcUrl: string
  maxConcurrentRpc: number
  addressBatchSize: number
  enableSwapReconstruction: boolean
}

const DEFAULT_CONFIG: TxHarvesterConfig = {
  intervalMs: 30_000,
  blockBatchSize: 2000,
  rpcUrl: '',
  maxConcurrentRpc: 5,
  addressBatchSize: 50,
  enableSwapReconstruction: true,
}

export async function harvestBaseTransactions(
  pool: pg.Pool,
  config: TxHarvesterConfig,
  tokenRegistry: TokenRegistry,
): Promise<number> {
  if (!config.rpcUrl) return 0

  const client = await pool.connect()
  let harvested = 0

  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('base_tx_harvester'))")
    if (!lockResult.rows[0].pg_try_advisory_lock) {
      return 0 // finally block handles client.release()
    }

    // Load active Base wallets
    const walletsResult = await client.query(
      "SELECT DISTINCT LOWER(address) as address, agent_entity FROM oracle_wallet_mappings WHERE chain = 'base' AND removed_at IS NULL",
    )
    if (walletsResult.rows.length === 0) {
      await client.query("SELECT pg_advisory_unlock(hashtext('base_tx_harvester'))")
      return 0 // finally block handles client.release()
    }

    const walletMap = new Map<string, string>()
    for (const row of walletsResult.rows) walletMap.set(row.address, row.agent_entity as string)
    const addresses = Array.from(walletMap.keys())

    // Get checkpoint
    const cpResult = await client.query("SELECT last_seen_id FROM oracle_worker_checkpoints WHERE source_table = $1", [CHECKPOINT_KEY])
    let fromBlock = cpResult.rows.length > 0 ? parseInt(cpResult.rows[0].last_seen_id as string, 10) + 1 : 0

    const currentBlock = await getCurrentBlock(config.rpcUrl)
    if (fromBlock === 0 || fromBlock > currentBlock) fromBlock = Math.max(currentBlock - 1000, 0)

    // Dynamic block batch — scale with wallet count but keep a reasonable minimum
    // With topic-filtered eth_getLogs, 2000 blocks is safe even with 1000+ wallets
    const effectiveBatch = Math.max(1000, Math.floor(config.blockBatchSize / Math.max(1, Math.ceil(addresses.length / 200))))
    const toBlock = Math.min(fromBlock + effectiveBatch, currentBlock)
    if (fromBlock >= toBlock) {
      await client.query("SELECT pg_advisory_unlock(hashtext('base_tx_harvester'))")
      return 0 // finally block handles client.release()
    }

    const fromHex = '0x' + fromBlock.toString(16)
    const toHex = '0x' + toBlock.toString(16)

    // Process in batches of addressBatchSize
    for (let i = 0; i < addresses.length; i += config.addressBatchSize) {
      const batch = addresses.slice(i, i + config.addressBatchSize)
      const paddedBatch = batch.map((a) => '0x' + '0'.repeat(24) + a.slice(2))

      // Query ALL ERC-20 transfers FROM agent wallets (no address filter = all tokens)
      const [outbound, inbound] = await Promise.all([
        queryLogs(config.rpcUrl, { topics: [TRANSFER_TOPIC, paddedBatch, null], fromBlock: fromHex, toBlock: toHex }),
        queryLogs(config.rpcUrl, { topics: [TRANSFER_TOPIC, null, paddedBatch], fromBlock: fromHex, toBlock: toHex }),
      ])

      // Process outbound transfers
      for (const log of outbound) {
        const from = '0x' + log.topics[1].slice(26).toLowerCase()
        const to = '0x' + log.topics[2].slice(26).toLowerCase()
        if (to === ZERO_ADDRESS || from === ZERO_ADDRESS) continue // skip mints/burns
        const entityId = walletMap.get(from)
        if (!entityId) continue

        const tokenAddress = log.address.toLowerCase()
        const token = tokenRegistry.lookup('base', tokenAddress)
        if (!token) tokenRegistry.queueResolution('base', tokenAddress)

        const amount = (log.data && log.data !== '0x' && log.data.length > 2) ? BigInt(log.data).toString() : '0'
        const usdValue = tokenRegistry.getUsdValue('base', tokenAddress, amount)

        // TODO: fetch real block timestamps from eth_getBlockByNumber instead of using now()
        await client.query(
          `INSERT INTO oracle_wallet_transactions
           (agent_entity, chain, wallet_address, tx_hash, block_number, log_index, direction, counterparty, token_address, token_symbol, token_decimals, amount, amount_usd, event_timestamp)
           VALUES ($1, 'base', $2, $3, $4::bigint, $5::int, 'outbound', $6, $7, $8, $9::int, $10, $11::numeric, now())
           ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
          [entityId, from, log.transactionHash, parseInt(log.blockNumber, 16), parseInt(log.logIndex, 16),
           to, tokenAddress, token?.symbol ?? null, token?.decimals ?? null, amount, usdValue],
        )
        harvested++
      }

      // Process inbound transfers
      for (const log of inbound) {
        const from = '0x' + log.topics[1].slice(26).toLowerCase()
        const to = '0x' + log.topics[2].slice(26).toLowerCase()
        if (to === ZERO_ADDRESS || from === ZERO_ADDRESS) continue
        const entityId = walletMap.get(to)
        if (!entityId) continue

        const tokenAddress = log.address.toLowerCase()
        const token = tokenRegistry.lookup('base', tokenAddress)
        if (!token) tokenRegistry.queueResolution('base', tokenAddress)

        const amount = (log.data && log.data !== '0x' && log.data.length > 2) ? BigInt(log.data).toString() : '0'
        const usdValue = tokenRegistry.getUsdValue('base', tokenAddress, amount)

        // TODO: fetch real block timestamps from eth_getBlockByNumber instead of using now()
        await client.query(
          `INSERT INTO oracle_wallet_transactions
           (agent_entity, chain, wallet_address, tx_hash, block_number, log_index, direction, counterparty, token_address, token_symbol, token_decimals, amount, amount_usd, event_timestamp)
           VALUES ($1, 'base', $2, $3, $4::bigint, $5::int, 'inbound', $6, $7, $8, $9::int, $10, $11::numeric, now())
           ON CONFLICT (chain, tx_hash, log_index) DO NOTHING`,
          [entityId, to, log.transactionHash, parseInt(log.blockNumber, 16), parseInt(log.logIndex, 16),
           from, tokenAddress, token?.symbol ?? null, token?.decimals ?? null, amount, usdValue],
        )
        harvested++
      }
    }

    // Swap reconstruction — group transfers by tx_hash
    if (config.enableSwapReconstruction && harvested > 0) {
      await classifyTransactions(client, fromBlock, toBlock)
    }

    // Resolve unknown tokens
    await tokenRegistry.resolveEvmPending(pool, config.rpcUrl)

    // Update checkpoint
    await client.query(
      `INSERT INTO oracle_worker_checkpoints (source_table, watermark_column, last_seen_ts, last_seen_id, updated_at)
       VALUES ($1, 'block_number', now(), $2, now())
       ON CONFLICT (source_table) DO UPDATE SET last_seen_id = $2, last_seen_ts = now(), updated_at = now()`,
      [CHECKPOINT_KEY, String(toBlock)],
    )

    await client.query("SELECT pg_advisory_unlock(hashtext('base_tx_harvester'))")
  } finally {
    client.release()
  }

  return harvested
}

/**
 * Classify transactions — honest heuristic, NOT reliable trade detection.
 *
 * Transfer grouping by tx_hash is a useful heuristic for swap-like transactions.
 * It is NOT definitive — LP adds, bridge movements, vault deposits, and router
 * churn can all look like swaps under this classification.
 *
 * Confidence levels:
 *   high   — 2 transfers, different tokens, one in + one out (classic swap pattern)
 *   medium — 3+ transfers with mixed directions and tokens (aggregator/multi-hop)
 *   low    — ambiguous pattern (could be LP, bridge, vault, etc.)
 */
async function classifyTransactions(client: pg.PoolClient, fromBlock: number, toBlock: number): Promise<void> {
  // Find transactions with 2+ unclassified transfers
  const groups = await client.query(
    `SELECT tx_hash, agent_entity,
            count(*) as cnt,
            count(DISTINCT token_address) as distinct_tokens,
            count(DISTINCT direction) as distinct_directions,
            bool_or(direction = 'inbound') as has_inbound,
            bool_or(direction = 'outbound') as has_outbound
     FROM oracle_wallet_transactions
     WHERE chain = 'base' AND block_number BETWEEN $1 AND $2 AND tx_type IS NULL
     GROUP BY tx_hash, agent_entity
     HAVING count(*) >= 2`,
    [fromBlock, toBlock],
  )

  for (const g of groups.rows) {
    const cnt = g.cnt as number
    const distinctTokens = g.distinct_tokens as number
    const hasInbound = g.has_inbound as boolean
    const hasOutbound = g.has_outbound as boolean

    let txType: string
    let confidence: string

    if (distinctTokens >= 2 && hasInbound && hasOutbound) {
      // Classic swap pattern: different tokens, bidirectional
      if (cnt === 2) {
        txType = 'swap'
        confidence = 'high'
      } else {
        txType = 'multi_hop_swap'
        confidence = 'medium'
      }
    } else if (distinctTokens >= 2 && cnt > 2) {
      // Could be LP add/remove, bridge, or aggregator routing
      txType = 'contract_interaction'
      confidence = 'low'
    } else {
      txType = 'unknown'
      confidence = 'low'
    }

    await client.query(
      `UPDATE oracle_wallet_transactions
       SET tx_type = $1, swap_group_id = $2, classification_confidence = $3
       WHERE chain = 'base' AND tx_hash = $2 AND agent_entity = $4 AND tx_type IS NULL`,
      [txType, g.tx_hash, confidence, g.agent_entity],
    )

    // For high-confidence swaps: compute execution delta and derive price observations
    if (txType === 'swap' && confidence === 'high') {
      await deriveSwapPriceObservation(client, g.tx_hash as string, g.agent_entity as string)
    }
  }

  // Mark remaining single transfers
  await client.query(
    `UPDATE oracle_wallet_transactions
     SET tx_type = 'transfer', classification_confidence = 'high'
     WHERE chain = 'base' AND block_number BETWEEN $1 AND $2 AND tx_type IS NULL`,
    [fromBlock, toBlock],
  )
}

/**
 * For high-confidence swaps with a stablecoin leg, derive a price observation
 * for the non-stablecoin token. Also compute execution_delta_usd.
 */
async function deriveSwapPriceObservation(client: pg.PoolClient, txHash: string, agentEntity: string): Promise<void> {
  const legs = await client.query(
    `SELECT direction, token_address, token_symbol, token_decimals, amount, amount_usd, block_number
     FROM oracle_wallet_transactions
     WHERE chain = 'base' AND tx_hash = $1 AND agent_entity = $2
     ORDER BY log_index`,
    [txHash, agentEntity],
  )
  if (legs.rows.length < 2) return

  const inbound = legs.rows.find((r) => r.direction === 'inbound')
  const outbound = legs.rows.find((r) => r.direction === 'outbound')
  if (!inbound || !outbound) return

  // Compute execution delta if both sides have USD values
  if (inbound.amount_usd != null && outbound.amount_usd != null) {
    const delta = Number(inbound.amount_usd) - Number(outbound.amount_usd)
    await client.query(
      `UPDATE oracle_wallet_transactions SET execution_delta_usd = $1
       WHERE chain = 'base' AND tx_hash = $2 AND agent_entity = $3 AND direction = 'inbound'`,
      [delta, txHash, agentEntity],
    )
  }

  // Derive price observation from stablecoin leg
  // If one side is a stablecoin, the other side's price can be inferred
  const stableLeg = [inbound, outbound].find((l) =>
    (STABLECOIN_SYMBOLS as readonly string[]).includes(l.token_symbol ?? ''),
  )
  const otherLeg = [inbound, outbound].find((l) => l !== stableLeg)

  if (stableLeg && otherLeg && stableLeg.token_decimals && otherLeg.token_decimals) {
    const stableAmount = Number(stableLeg.amount) / Math.pow(10, stableLeg.token_decimals)
    const otherAmount = Number(otherLeg.amount) / Math.pow(10, otherLeg.token_decimals)

    if (otherAmount > 0 && stableAmount > 0) {
      const derivedPrice = stableAmount / otherAmount

      await client.query(
        `INSERT INTO oracle_price_observations (chain, token_address, price_usd, source, confidence, observed_at, block_number, tx_hash)
         VALUES ('base', $1, $2, 'stablecoin_leg', 'high', to_timestamp($3), $3, $4)`,
        [otherLeg.token_address, derivedPrice, otherLeg.block_number, txHash],
      )

      // Update token registry with latest price
      await client.query(
        `UPDATE oracle_token_registry SET last_known_usd_price = $1, price_updated_at = now()
         WHERE chain = 'base' AND token_address = $2`,
        [derivedPrice, otherLeg.token_address],
      )
    }
  }
}

async function getCurrentBlock(rpcUrl: string): Promise<number> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  })
  const d = await res.json() as { result: string }
  return parseInt(d.result, 16)
}

interface LogEntry {
  address: string
  topics: string[]
  data: string
  transactionHash: string
  blockNumber: string
  logIndex: string
}

async function queryLogs(
  rpcUrl: string,
  params: { topics: (string | string[] | null)[]; fromBlock: string; toBlock: string },
): Promise<LogEntry[]> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [params] }),
  })
  const d = await res.json() as { result?: LogEntry[]; error?: { message: string } }
  if (d.error) {
    if (d.error.message.includes('limited to a 10,000')) return [] // block range too large
    console.error('[tx-harvester] RPC error:', d.error.message)
    return []
  }
  return d.result ?? []
}

/**
 * Start the Base transaction harvester on a timer.
 */
export function startTxHarvester(
  pool: pg.Pool,
  config: Partial<TxHarvesterConfig> & { rpcUrl: string },
): { stop: () => void } {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  const tokenRegistry = new TokenRegistry()
  let running = true

  const loop = async () => {
    await tokenRegistry.loadFromDb(pool)
    while (running) {
      try {
        const n = await harvestBaseTransactions(pool, fullConfig, tokenRegistry)
        if (n > 0) console.log(`[tx-harvester] Harvested ${n} transfers`)
      } catch (err) {
        console.error('[tx-harvester] Error:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, fullConfig.intervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
