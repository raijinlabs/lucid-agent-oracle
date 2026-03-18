import { ponder } from '@/generated'
import { writeWalletEvent } from './adapter-sink.js'
import { computeEventId } from '@lucid/oracle-core'

/**
 * In-memory watchlist of known agent wallets on Base.
 * Loaded from Postgres on startup, refreshed via Redis SUBSCRIBE or timer fallback.
 */
const watchedAddresses = new Set<string>()

async function loadWatchlist(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) return

  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  try {
    const result = await client.query(
      `SELECT LOWER(address) as address FROM oracle_wallet_mappings WHERE chain = 'base' AND removed_at IS NULL`,
    )
    watchedAddresses.clear()
    for (const row of result.rows) {
      watchedAddresses.add(row.address)
    }
    console.log(`[ponder] Loaded ${watchedAddresses.size} watched Base addresses`)
  } finally {
    await client.end()
  }
}

async function startWatchlistRefresh(): Promise<void> {
  const redisUrl = process.env.REDIS_URL
  if (redisUrl) {
    // Redis SUBSCRIBE for real-time watchlist updates
    try {
      const { createClient } = await import('redis')
      const sub = createClient({ url: redisUrl })
      await sub.connect()
      await sub.subscribe('oracle:watchlist:updated', async () => {
        await loadWatchlist()
      })
      console.log('[ponder] Watchlist subscribed to Redis oracle:watchlist:updated')
      return
    } catch (err) {
      console.warn('[ponder] Redis subscribe failed, falling back to timer:', (err as Error).message)
    }
  }
  // Fallback: reload every 60s
  setInterval(() => {
    loadWatchlist().catch((err) => {
      console.error('[ponder] Watchlist timer reload failed:', (err as Error).message)
    })
  }, 60_000)
  console.log('[ponder] Watchlist refresh: timer fallback (60s)')
}

// Initialize on module load
if (process.env.DATABASE_URL) {
  loadWatchlist()
    .then(() => startWatchlistRefresh())
    .catch((err) => {
      console.error('[ponder] Failed to init watchlist:', (err as Error).message)
    })
}

ponder.on('BaseUSDC:Transfer', async ({ event }) => {
  const from = event.args.from.toLowerCase()
  const to = event.args.to.toLowerCase()

  // Filter: at least one side must be a watched agent wallet
  const isFromWatched = watchedAddresses.has(from)
  const isToWatched = watchedAddresses.has(to)
  if (!isFromWatched && !isToWatched) return

  const subject = isFromWatched ? from : to
  const counterparty = isFromWatched ? to : from

  await writeWalletEvent({
    event_id: computeEventId('agent_wallets_evm', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'agent_wallets_evm',
    source_adapter_ver: 1,
    chain: 'base',
    event_type: 'transfer',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    payload_json: JSON.stringify({
      subject_raw_id: subject,
      counterparty_raw_id: counterparty,
      amount: event.args.value.toString(),
      currency: 'USDC',
    }),
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
  })
})
