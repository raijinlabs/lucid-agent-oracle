/**
 * Solana Identity Indexer — orchestrates Solana identity providers.
 *
 * Polls Helius for transactions touching each provider's program IDs,
 * dispatches to providers for parsing, and writes staging events to
 * oracle_raw_adapter_events for the resolver pipeline to pick up.
 *
 * Uses advisory locks to prevent concurrent indexer instances.
 * Follows the same patterns as other enrichers (withAdvisoryLock, startEnricherLoop).
 */
import type pg from 'pg'
import { computeEventId } from '../../types/events.js'
import type { SolanaIdentityProvider, SolanaIdentityIndexerConfig, StagingEvent } from './types.js'
import type { HeliusTransaction } from '../helius.js'

const LOCK_NAME = 'solana_identity_indexer'
const CHECKPOINT_KEY = 'solana_identity_indexer'

/**
 * Fetch transaction signatures for a program from Helius.
 * Uses getSignaturesForAddress via the standard Solana RPC (Helius-enhanced).
 */
async function fetchSignatures(
  heliusApiKey: string,
  programId: string,
  beforeSignature: string | undefined,
  limit: number,
): Promise<Array<{ signature: string; slot: number; blockTime: number | null }>> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`

  const params: Record<string, any> = { limit, commitment: 'confirmed' }
  if (beforeSignature) params.before = beforeSignature

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [programId, params],
      }),
      signal: controller.signal,
    })

    if (!res.ok) return []
    const json = await res.json() as any
    return json.result ?? []
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a parsed transaction from Helius Enhanced Transactions API.
 */
async function fetchEnhancedTransaction(
  heliusApiKey: string,
  signature: string,
): Promise<HeliusTransaction | null> {
  const url = `https://api.helius.xyz/v0/transactions/?api-key=${heliusApiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
      signal: controller.signal,
    })

    if (!res.ok) return null
    const txs = await res.json() as HeliusTransaction[]
    return txs[0] ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a raw parsed transaction via Solana RPC (through Helius).
 * This gives us access to logMessages which contain Anchor event data.
 */
async function fetchParsedTransaction(
  heliusApiKey: string,
  signature: string,
): Promise<any | null> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      }),
      signal: controller.signal,
    })

    if (!res.ok) return null
    const json = await res.json() as any
    return json.result ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build a HeliusTransaction-compatible object from the parsed RPC response,
 * merging in logMessages for Anchor event parsing.
 */
function mergeTransactionData(
  enhanced: HeliusTransaction | null,
  parsed: any | null,
  signature: string,
  slot: number,
  blockTime: number | null,
): HeliusTransaction & { logMessages?: string[] } {
  const base: HeliusTransaction & { logMessages?: string[] } = enhanced ?? {
    signature,
    type: 'UNKNOWN',
    timestamp: blockTime ?? Math.floor(Date.now() / 1000),
    slot,
    nativeTransfers: [],
    tokenTransfers: [],
    accountData: [],
    description: '',
  }

  // Merge logMessages from the parsed RPC response
  if (parsed?.meta?.logMessages) {
    (base as any).logMessages = parsed.meta.logMessages
  }

  // Ensure slot is set
  if (!base.slot && slot) base.slot = slot

  return base
}

/**
 * Write staging events to the oracle_raw_adapter_events table.
 */
async function writeStagingEvents(
  client: pg.PoolClient,
  events: StagingEvent[],
): Promise<number> {
  let written = 0

  for (const event of events) {
    const eventId = computeEventId(event.source, event.chain, event.tx_hash, 0)

    // Merge agent_id into payload for the resolver to pick up
    const payloadWithId = {
      ...event.payload,
      agent_id: event.agent_id,
    }

    await client.query(
      `INSERT INTO oracle_raw_adapter_events
        (event_id, source, source_adapter_ver, chain, event_type,
         event_timestamp, payload_json, block_number, tx_hash)
       VALUES ($1, $2, $3::int, $4, $5, $6::timestamptz, $7, $8::bigint, $9)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        eventId,
        event.source,
        1,
        event.chain,
        event.event_type,
        new Date().toISOString(),
        JSON.stringify(payloadWithId),
        event.block_number,
        event.tx_hash,
      ],
    )
    written++
  }

  return written
}

/**
 * Run a single indexing cycle: poll each provider's programs for new
 * transactions, parse them, and write staging events.
 */
export async function indexSolanaIdentityEvents(
  pool: pg.Pool,
  config: SolanaIdentityIndexerConfig,
): Promise<number> {
  if (!config.heliusApiKey || config.providers.length === 0) return 0

  const client = await pool.connect()
  let totalWritten = 0

  try {
    // Acquire advisory lock
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1::text))`,
      [LOCK_NAME],
    )
    if (!lockResult.rows[0].pg_try_advisory_lock) return 0

    // Load per-program cursors
    const cpResult = await client.query(
      `SELECT last_seen_id FROM oracle_worker_checkpoints WHERE source_table = $1`,
      [CHECKPOINT_KEY],
    )
    const cursors: Record<string, string> = cpResult.rows.length > 0
      ? JSON.parse(cpResult.rows[0].last_seen_id as string)
      : {}

    for (const provider of config.providers) {
      for (const programId of provider.programIds) {
        const cursorKey = `${provider.id}:${programId}`
        const lastSig = cursors[cursorKey]

        try {
          // Fetch transaction signatures — paginate fully on first run (no cursor)
          let allSigs: Awaited<ReturnType<typeof fetchSignatures>> = []
          let pageCursor = lastSig
          const maxPages = lastSig ? 1 : 50 // First run: up to 50 pages (5000 txs); after: 1 page

          for (let page = 0; page < maxPages; page++) {
            const sigs = await fetchSignatures(
              config.heliusApiKey,
              programId,
              pageCursor,
              100, // Max per page for backfill
            )
            if (sigs.length === 0) break
            allSigs = allSigs.concat(sigs)
            pageCursor = sigs[sigs.length - 1].signature
            if (sigs.length < 100) break // Last page
            await new Promise(r => setTimeout(r, 200))
          }

          if (allSigs.length === 0) continue

          // Filter out already-seen signatures
          const newSigs = lastSig
            ? allSigs.filter(s => s.signature !== lastSig)
            : allSigs

          if (newSigs.length === 0) continue
          if (!lastSig) console.log(`[solana-identity] Backfilling ${newSigs.length} transactions for ${provider.id}:${programId.slice(0, 8)}`)

          // Process oldest first
          const orderedSigs = [...newSigs].reverse()

          for (const sigInfo of orderedSigs) {
            try {
              // Fetch both enhanced and parsed transaction data
              const [enhanced, parsed] = await Promise.all([
                fetchEnhancedTransaction(config.heliusApiKey, sigInfo.signature),
                fetchParsedTransaction(config.heliusApiKey, sigInfo.signature),
              ])

              const merged = mergeTransactionData(
                enhanced,
                parsed,
                sigInfo.signature,
                sigInfo.slot,
                sigInfo.blockTime,
              )

              // Parse with provider
              const events = provider.parseTransaction(merged)

              if (events.length > 0) {
                const n = await writeStagingEvents(client, events)
                totalWritten += n
              }
            } catch (err) {
              console.error(
                `[solana-identity] Error processing tx ${sigInfo.signature.slice(0, 12)}:`,
                (err as Error).message,
              )
            }

            // Rate limiting: 100ms between transactions
            await new Promise(r => setTimeout(r, 100))
          }

          // Update cursor to newest signature
          cursors[cursorKey] = newSigs[0].signature
        } catch (err) {
          console.error(
            `[solana-identity] Error polling ${provider.id}/${programId.slice(0, 8)}:`,
            (err as Error).message,
          )
        }
      }
    }

    // Save cursors
    await client.query(
      `INSERT INTO oracle_worker_checkpoints (source_table, watermark_column, last_seen_ts, last_seen_id, updated_at)
       VALUES ($1, 'created_at', now(), $2, now())
       ON CONFLICT (source_table) DO UPDATE SET last_seen_id = $2, last_seen_ts = now(), updated_at = now()`,
      [CHECKPOINT_KEY, JSON.stringify(cursors)],
    )

    // Release advisory lock
    await client.query(
      `SELECT pg_advisory_unlock(hashtext($1::text))`,
      [LOCK_NAME],
    )
  } finally {
    client.release()
  }

  return totalWritten
}

/**
 * Start the Solana Identity Indexer on a timer loop.
 *
 * Usage:
 *   const { stop } = startSolanaIdentityIndexer(pool, {
 *     heliusApiKey: 'xxx',
 *     providers: [new Sol8004Provider()],
 *     pollIntervalMs: 30_000,
 *     batchSize: 50,
 *   })
 */
export function startSolanaIdentityIndexer(
  pool: pg.Pool,
  config: Partial<SolanaIdentityIndexerConfig> & {
    heliusApiKey: string
    providers: SolanaIdentityProvider[]
  },
): { stop: () => void } {
  const fullConfig: SolanaIdentityIndexerConfig = {
    heliusApiKey: config.heliusApiKey,
    providers: config.providers,
    pollIntervalMs: config.pollIntervalMs ?? 30_000,
    batchSize: config.batchSize ?? 50,
  }

  let running = true

  const loop = async () => {
    while (running) {
      try {
        const n = await indexSolanaIdentityEvents(pool, fullConfig)
        if (n > 0) {
          console.log(`[solana-identity] Wrote ${n} staging events`)
        }
      } catch (err) {
        console.error('[solana-identity] Error:', (err as Error).message)
      }
      await new Promise(r => setTimeout(r, fullConfig.pollIntervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
