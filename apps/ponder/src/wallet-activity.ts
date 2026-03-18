import { ponder } from '@/generated'
import { Kafka } from 'kafkajs'
import { publishToWalletActivity } from './redpanda-sink.js'
import { computeEventId } from '../../../packages/core/src/types/events.js'

/**
 * In-memory watchlist of known agent wallets on Base.
 * Loaded from Postgres on startup, refreshed via wallet_watchlist.updated Redpanda topic.
 * Ponder indexes ALL USDC transfers; this set filters to agent wallets only.
 *
 * Refresh path: resolver publishes wallet_watchlist.updated → this consumer
 * reloads the full set from Postgres. We reload from DB (not just apply the delta)
 * to stay consistent even if messages are missed or replayed.
 */
const watchedAddresses = new Set<string>()

/** Load watched addresses from Postgres oracle_wallet_mappings table. */
async function loadWatchlist(dbUrl: string): Promise<void> {
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

/**
 * Start a KafkaJS consumer that listens for wallet_watchlist.updated events
 * and reloads the in-memory watchlist from Postgres when any arrive.
 */
async function startWatchlistConsumer(dbUrl: string, brokers: string[]): Promise<void> {
  const kafka = new Kafka({ clientId: 'oracle-ponder-watchlist', brokers })
  const consumer = kafka.consumer({ groupId: 'oracle-ponder-watchlist' })
  await consumer.connect()
  await consumer.subscribe({ topic: 'wallet_watchlist.updated', fromBeginning: false })
  await consumer.run({
    eachMessage: async () => {
      // On any watchlist update, reload the full set from Postgres.
      // This is safe because loadWatchlist clears + rebuilds the set.
      await loadWatchlist(dbUrl)
    },
  })
  console.log('[ponder] Watchlist consumer started — listening for wallet_watchlist.updated')
}

// Initialize on module load
const DB_URL = process.env.DATABASE_URL
const BROKERS = (process.env.REDPANDA_BROKERS ?? 'localhost:9092').split(',')
if (DB_URL) {
  loadWatchlist(DB_URL)
    .then(() => startWatchlistConsumer(DB_URL, BROKERS))
    .catch((err) => {
      console.error('[ponder] Failed to init watchlist:', err.message)
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

  const rawEvent = {
    event_id: computeEventId('agent_wallets_evm', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'agent_wallets_evm',
    source_adapter_ver: 1,
    ingestion_type: 'realtime',
    ingestion_ts: new Date().toISOString(),
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    event_type: 'transfer',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    subject_entity_id: null,
    subject_raw_id: subject,
    subject_id_type: 'wallet',
    counterparty_raw_id: counterparty,
    protocol: 'independent',
    amount: event.args.value.toString(),
    currency: 'USDC',
    usd_value: null,
    tool_name: null,
    model_id: null,
    provider: null,
    duration_ms: null,
    status: 'success',
    quality_score: 1.0,
    economic_authentic: true,
    corrects_event_id: null,
    correction_reason: null,
  }
  await publishToWalletActivity(`base:${subject}`, rawEvent)
})
