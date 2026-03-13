import Fastify from 'fastify'
import cors from '@fastify/cors'
import {
  OracleClickHouse,
  RedpandaConsumer,
  RedpandaProducer,
  TOPICS,
  registerDefaultAdapters,
  mountWebhookRoutes,
  dispatchIdentityEvent,
  getIdentityTopics,
  adapterRegistry,
} from '@lucid/oracle-core'
import type { WatchlistUpdate } from '@lucid/oracle-core'
import { registerOracleRoutes, initFeedCache, handleIndexUpdate, reconcileFeedCache } from './routes/v1.js'
import { WalletWatchlist } from './services/wallet-watchlist.js'

const PORT = parseInt(process.env.PORT ?? '4040', 10)
const app = Fastify({ logger: true })

await app.register(cors, {
  origin: true,
  exposedHeaders: ['X-Request-Id'],
})

app.get('/health', async () => ({
  status: 'ok',
  service: 'oracle-economy-api',
  timestamp: new Date().toISOString(),
}))

registerOracleRoutes(app)

// Plan 2A startup sequence
const clickhouseUrl = process.env.CLICKHOUSE_URL
const redpandaBrokers = process.env.REDPANDA_BROKERS

let clickhouse: OracleClickHouse | null = null
let consumer: RedpandaConsumer | null = null

if (clickhouseUrl && redpandaBrokers) {
  // 1. Connect to ClickHouse
  clickhouse = new OracleClickHouse({
    url: clickhouseUrl,
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  })

  // 2. Connect Redpanda consumer
  const hostname = process.env.HOSTNAME ?? `api-${process.pid}`
  consumer = new RedpandaConsumer({
    brokers: redpandaBrokers.split(','),
    groupId: `oracle-api-${hostname}`,
  })

  // 3. Backfill from ClickHouse
  await initFeedCache(clickhouse)
  app.log.info('Feed cache backfilled from ClickHouse')

  // 4. Start consumer
  await consumer.subscribe([TOPICS.INDEX_UPDATES])
  consumer.runRaw(async (_key, value) => {
    if (value) handleIndexUpdate(value)
  }).catch((err) => {
    app.log.error('INDEX_UPDATES consumer error:', err)
  })
  app.log.info('INDEX_UPDATES consumer started')

  // 5. Reconcile
  await reconcileFeedCache(clickhouse)
  app.log.info('Feed cache reconciled')
} else {
  app.log.warn('CLICKHOUSE_URL or REDPANDA_BROKERS not set — running in Plan 1 mode (empty cache)')
}

// Plan 4A: Registry-driven identity resolver + webhook auto-wiring
registerDefaultAdapters()
app.log.info(`Adapter registry: ${adapterRegistry.sources().join(', ')} (${adapterRegistry.size} adapters)`)

const databaseUrl = process.env.DATABASE_URL

let resolverConsumer: RedpandaConsumer | null = null
let watchlistConsumer: RedpandaConsumer | null = null
let resolverProducer: RedpandaProducer | null = null
let pgClient: { end(): Promise<void> } | null = null

if (databaseUrl && redpandaBrokers) {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  pgClient = client

  resolverProducer = new RedpandaProducer({
    brokers: redpandaBrokers.split(','),
    clientId: 'oracle-api-resolver',
  })
  await resolverProducer.connect()

  const watchlist = new WalletWatchlist(client)
  await watchlist.loadSolanaWallets()
  await watchlist.loadBaseWallets()
  app.log.info(`Watchlist loaded: ${watchlist.getSolanaWallets().size} Solana, ${watchlist.getBaseWallets().size} Base wallets`)

  // Auto-discover identity topics from registry and subscribe
  const identityTopics = getIdentityTopics()
  if (identityTopics.length > 0) {
    resolverConsumer = new RedpandaConsumer({
      brokers: redpandaBrokers.split(','),
      groupId: 'oracle-api-resolver',
    })
    await resolverConsumer.subscribe(identityTopics)
    resolverConsumer.runRaw(async (_key, value) => {
      if (!value) return
      const event = JSON.parse(value) as Record<string, unknown>
      const source = event.source as string
      await dispatchIdentityEvent(source, event, client, resolverProducer!)
    }).catch((err) => {
      app.log.error('Identity resolver consumer error:', err)
    })
    app.log.info(`Identity resolver subscribed to: ${identityTopics.join(', ')}`)
  }

  // Start watchlist consumer
  watchlistConsumer = new RedpandaConsumer({
    brokers: redpandaBrokers.split(','),
    groupId: 'oracle-api-watchlist',
  })
  await watchlistConsumer.subscribe([TOPICS.WATCHLIST])
  watchlistConsumer.runRaw(async (_key, value) => {
    if (!value) return
    const update = JSON.parse(value) as WatchlistUpdate
    watchlist.handleWatchlistUpdate(update)
  }).catch((err) => {
    app.log.error('Watchlist consumer error:', err)
  })

  // Auto-mount webhook routes from registry
  const webhookCount = mountWebhookRoutes(app, resolverProducer, {
    env: process.env as Record<string, string | undefined>,
    services: { watchlist },
  })
  if (webhookCount > 0) {
    app.log.info(`${webhookCount} webhook route(s) auto-mounted from adapter registry`)
  }

  app.log.info('Identity resolver started')
} else if (!databaseUrl) {
  app.log.warn('DATABASE_URL not set — identity resolver disabled')
}

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...')
  // Plan 4A resources
  await resolverConsumer?.disconnect().catch(() => {})
  await watchlistConsumer?.disconnect().catch(() => {})
  await resolverProducer?.disconnect().catch(() => {})
  await pgClient?.end().catch(() => {})
  // Plan 2A resources
  await consumer?.disconnect()
  await clickhouse?.close()
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Oracle Economy API listening on :${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

export { app }
