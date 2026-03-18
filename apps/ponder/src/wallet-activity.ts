import { ponder } from '@/generated'
import { recordWalletActivity } from './db-sink.js'

// USDC has 6 decimals
const USDC_DECIMALS = 6

/**
 * In-memory watchlist of known agent wallets on Base.
 * Loaded from Postgres on startup.
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

// Load on startup
if (process.env.DATABASE_URL) {
  loadWatchlist().catch((err) => {
    console.error('[ponder] Failed to load watchlist:', err.message)
  })
}

ponder.on('BaseUSDC:Transfer', async ({ event }) => {
  const from = event.args.from.toLowerCase()
  const to = event.args.to.toLowerCase()

  // Filter: at least one side must be a watched agent wallet
  const isFromWatched = watchedAddresses.has(from)
  const isToWatched = watchedAddresses.has(to)
  if (!isFromWatched && !isToWatched) return

  const usdValue = Number(event.args.value) / 10 ** USDC_DECIMALS
  if (usdValue < 0.01) return // skip dust

  const subject = isFromWatched ? from : to

  await recordWalletActivity({
    chain: 'base',
    address: subject,
    tx_hash: event.transaction.hash,
    usd_value: usdValue,
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
  })
})
