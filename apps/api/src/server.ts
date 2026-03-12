import Fastify from 'fastify'
import cors from '@fastify/cors'
import { OracleClickHouse, RedpandaConsumer, TOPICS } from '@lucid/oracle-core'
import { registerOracleRoutes, initFeedCache, handleIndexUpdate, reconcileFeedCache } from './routes/v1.js'

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

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...')
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
