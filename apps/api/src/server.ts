import { startTelemetry, shutdownTelemetry } from './telemetry.js'
startTelemetry()

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import {
  OracleClickHouse,
  RedpandaConsumer,
  RedpandaProducer,
  TOPICS,
  registerDefaultAdapters,
  mountWebhookRoutes,
  createAdapterSink,
  startResolverPoller,
  startURIResolver,
  startTxHarvester,
  startSolanaTxHarvester,
  startMoralisClassifier,
  startBalanceEnricher,
  startEconomyMetrics,
  startENSResolver,
  startOlasEnricher,
  startGasMetrics,
  startContractAnalyzer,
  startDefiEnricher,
  startNftEnricher,
  dispatchIdentityEvent,
  getIdentityTopics,
  adapterRegistry,
} from '@lucid/oracle-core'
import type { WatchlistUpdate } from '@lucid/oracle-core'
import { verifierRegistry, evmVerifier, solanaVerifier } from '@lucid/oracle-core'
import { registerOracleRoutes, initFeedCache, handleIndexUpdate, reconcileFeedCache } from './routes/v1.js'
import { WalletWatchlist } from './services/wallet-watchlist.js'
import { registerIdentityRoutes, cleanupExpiredChallenges } from './routes/identity-registration.js'
import { registerAdminRoutes } from './routes/identity-admin.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerProtocolRoutes } from './routes/protocols.js'
import { registerEconomyRoutes } from './routes/economy.js'
import { registerFeedRoutes } from './routes/feeds.js'
import { registerReportRoutes } from './routes/reports.js'
import { LucidResolver } from './services/lucid-resolver.js'
import { initRedis, closeRedis, loadLeaderboardVersion } from './services/redis.js'
import { EventBus } from './services/event-bus.js'
import { registerStreamRoutes } from './routes/stream.js'
import { registerAlertRoutes } from './routes/alerts.js'
import { StreamTokenResponse, StreamQuery } from './schemas/stream.js'
import {
  CreateAlertBody, CreateAlertResponse, AlertListResponse,
  AlertSubscription, AlertIdParams,
} from './schemas/alerts.js'
import { authPlugin } from './plugins/auth.js'
import cachePlugin from './plugins/cache.js'
import rateLimitPlugin from './plugins/rate-limit.js'
import { ProblemDetail, CursorQuery, CursorMeta, AgentIdParams, ProtocolIdParams, registerGlobalErrorHandler } from './schemas/common.js'
import { assertCursorSecret } from './utils/cursor.js'

const PORT = parseInt(process.env.PORT ?? '4040', 10)
const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>()

// OpenAPI / Swagger
await app.register(swagger, {
  openapi: {
    openapi: '3.0.0',
    info: {
      title: 'Lucid Agent Oracle API',
      version: '1.0.0',
      description: 'Economic intelligence for the agent economy.',
    },
    servers: [
      { url: process.env.API_PUBLIC_URL ?? 'http://localhost:4040' },
    ],
    tags: [
      { name: 'agents', description: 'Agent identity, metrics, and activity' },
      { name: 'protocols', description: 'Protocol registry and metrics' },
      { name: 'feeds', description: 'Oracle economic feeds' },
      { name: 'reports', description: 'Signed attestation reports' },
      { name: 'streaming', description: 'SSE streaming and stream tokens' },
      { name: 'alerts', description: 'Webhook alert subscriptions' },
    ],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'apiKey',
          name: 'x-api-key',
          in: 'header',
          description: 'API key for authenticated access. Determines plan tier (free/pro/growth).',
        },
      },
    },
  },
})
await app.register(swaggerUi, { routePrefix: '/docs' })

// Shared TypeBox schemas for $ref reuse in OpenAPI
app.addSchema(ProblemDetail)
app.addSchema(CursorQuery)
app.addSchema(CursorMeta)
app.addSchema(AgentIdParams)
app.addSchema(ProtocolIdParams)
app.addSchema(StreamTokenResponse)
app.addSchema(StreamQuery)
app.addSchema(CreateAlertBody)
app.addSchema(AlertSubscription)
app.addSchema(CreateAlertResponse)
app.addSchema(AlertListResponse)
app.addSchema(AlertIdParams)

// Global error handler — ensures ALL errors are RFC 9457 Problem Details
registerGlobalErrorHandler(app)

await app.register(cors, {
  origin: true,
  exposedHeaders: [
    'X-Request-Id',
    'X-Cache',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'Retry-After',
  ],
})

// Init Redis (before plugins that need it)
const redis = await initRedis(process.env.REDIS_URL)
if (redis) {
  app.log.info('Redis connected')
  await loadLeaderboardVersion()
} else {
  app.log.warn('REDIS_URL not set — running without Redis cache')
}

// Plan 3E: EventBus (dual fanout to Pub/Sub for SSE + Streams for webhooks)
const eventBus = new EventBus()

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

if (clickhouseUrl) {
  // 1. Connect to ClickHouse
  clickhouse = new OracleClickHouse({
    url: clickhouseUrl,
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  })

  // 2. Backfill from ClickHouse
  await initFeedCache(clickhouse)
  app.log.info('Feed cache backfilled from ClickHouse')

  // 3. Reconcile
  await reconcileFeedCache(clickhouse)
  app.log.info('Feed cache reconciled')
}

if (clickhouseUrl && redpandaBrokers) {
  // 4. Connect Redpanda consumer (optional — for real-time updates)
  const hostname = process.env.HOSTNAME ?? `api-${process.pid}`
  consumer = new RedpandaConsumer({
    brokers: redpandaBrokers.split(','),
    groupId: `oracle-api-${hostname}`,
  })

  await consumer.subscribe([TOPICS.INDEX_UPDATES])
  consumer.runRaw(async (_key, value) => {
    if (value) {
      handleIndexUpdate(value)
      // Plan 3E: Fan out to SSE + webhook queue
      try {
        const row = JSON.parse(value) as Record<string, unknown>
        void eventBus.emit({
          channel: 'feeds',
          payload: {
            feedId: row.feed_id,
            value: Number(row.value),
            confidence: row.confidence,
            freshness: row.freshness_ms,
            revision: row.revision,
          },
          sse: true,
          webhook: true,
        })
      } catch {
        // Skip malformed events
      }
    }
  }).catch((err) => {
    app.log.error('INDEX_UPDATES consumer error:', err)
  })
  app.log.info('INDEX_UPDATES consumer started')

} else if (!clickhouseUrl) {
  app.log.warn('CLICKHOUSE_URL not set — running in Plan 1 mode (empty cache)')
}

// Plan 4A: Registry-driven identity resolver + webhook auto-wiring
registerDefaultAdapters()
app.log.info(`Adapter registry: ${adapterRegistry.sources().join(', ')} (${adapterRegistry.size} adapters)`)

// Plan 4B: Register signature verifiers
verifierRegistry.register(evmVerifier)
verifierRegistry.register(solanaVerifier)
app.log.info(`Verifier registry: ${verifierRegistry.supportedChains().join(', ')}`)

const databaseUrl = process.env.DATABASE_URL

let resolverConsumer: RedpandaConsumer | null = null
let watchlistConsumer: RedpandaConsumer | null = null
let resolverProducer: RedpandaProducer | null = null
let pgClient: { end(): Promise<void> } | null = null

if (databaseUrl) {
  const { default: pg } = await import('pg')
  const sharedPool = new pg.Pool({ connectionString: databaseUrl, max: 20 })
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  pgClient = client

  const watchlist = new WalletWatchlist(client)
  await watchlist.loadSolanaWallets()
  await watchlist.loadBaseWallets()
  app.log.info(`Watchlist loaded: ${watchlist.getSolanaWallets().size} Solana, ${watchlist.getBaseWallets().size} Base wallets`)

  // Redpanda-dependent features (optional)
  if (redpandaBrokers) {
    resolverProducer = new RedpandaProducer({
      brokers: redpandaBrokers.split(','),
      clientId: 'oracle-api-resolver',
    })
    await resolverProducer.connect()

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

    // Auto-mount webhook routes (with sink for no-broker mode)
    const adapterSink = createAdapterSink({ databaseUrl, brokers: redpandaBrokers })
    const webhookCount = mountWebhookRoutes(app, resolverProducer as any, {
      env: process.env as Record<string, string | undefined>,
      services: { watchlist },
      sink: adapterSink,
    })
    if (webhookCount > 0) {
      app.log.info(`${webhookCount} webhook route(s) auto-mounted from adapter registry`)
    }
  } else {
    // No Redpanda: create sink + mount webhooks without broker
    const adapterSink = createAdapterSink({ databaseUrl })
    const webhookCount = mountWebhookRoutes(app, null as any, {
      env: process.env as Record<string, string | undefined>,
      services: { watchlist },
      sink: adapterSink,
    })
    if (webhookCount > 0) {
      app.log.info(`${webhookCount} webhook route(s) auto-mounted (no-broker mode)`)
    }

    app.log.warn('REDPANDA_BROKERS not set — identity resolver and watchlist consumers disabled')
  }

  // Start resolver poller (processes staging table events → identity tables)
  const resolverPoller = startResolverPoller(
    sharedPool,
    async (source, payload, db) => {
      await dispatchIdentityEvent(source, payload as Record<string, unknown>, db as any, null as any)
    },
    { pollIntervalMs: parseInt(process.env.RESOLVER_POLL_INTERVAL_MS ?? '5000', 10), batchSize: 100 },
  )
  app.log.info('Resolver poller started (processes adapter staging events)')

  // URI Resolver — fetches agent registration JSON files, extracts services/wallets
  startURIResolver(sharedPool)
  app.log.info('URI resolver started (resolves agent registration files)')

  // === DATA INGESTION (always runs if keys are present — ingest everything) ===
  // Access gating is at the API layer (auth/tiering), not at ingestion.

  const baseRpcUrl = process.env.BASE_RPC_URL
  if (baseRpcUrl) {
    startTxHarvester(sharedPool, { intervalMs: 30_000, blockBatchSize: 2000, rpcUrl: baseRpcUrl })
    app.log.info('[ingestion:base] TX harvester started')
  }

  const heliusApiKey = process.env.HELIUS_API_KEY
  if (heliusApiKey) {
    startSolanaTxHarvester(sharedPool, { intervalMs: 60_000, walletsPerCycle: 50, heliusApiKey })
    app.log.info('[ingestion:solana] TX harvester started')
  }

  // Moralis classifier — reclassifies Base transactions with high-accuracy labels
  const moralisApiKey = process.env.MORALIS_API_KEY
  if (moralisApiKey) {
    startMoralisClassifier(sharedPool, { apiKey: moralisApiKey, intervalMs: 60_000, batchSize: 20 })
    app.log.info('[ingestion:moralis] Swap classifier started (high-accuracy)')

    // Balance enricher — polls Moralis for token balances (reuses same API key)
    startBalanceEnricher(sharedPool, { apiKey: moralisApiKey, intervalMs: 5 * 60_000, walletsPerCycle: 20 })
    app.log.info('[ingestion:moralis] Balance enricher started (5min cycle)')

    // DeFi position enricher — polls Moralis for LP/staking/lending positions
    startDefiEnricher(sharedPool, { apiKey: moralisApiKey, intervalMs: 30 * 60_000, batchSize: 10 })
    app.log.info('[enrichment:moralis] DeFi position enricher started (30min cycle)')

    // NFT holdings enricher — polls Moralis for NFT holdings
    startNftEnricher(sharedPool, { apiKey: moralisApiKey, intervalMs: 30 * 60_000, batchSize: 10 })
    app.log.info('[enrichment:moralis] NFT holdings enricher started (30min cycle)')
  }

  // Economy metrics — hourly snapshots of economy health
  startEconomyMetrics(sharedPool, { intervalMs: 60 * 60_000 })
  app.log.info('[metrics] Economy snapshot computer started (hourly)')

  // Phase B: ENS / Basename resolver (requires MORALIS_API_KEY or BASE_RPC_URL)
  if (moralisApiKey || baseRpcUrl) {
    startENSResolver(sharedPool, { moralisApiKey, baseRpcUrl, intervalMs: 10 * 60_000, addressesPerCycle: 50 })
    app.log.info('[enrichment] ENS/Basename resolver started (10min cycle)')
  }

  // Phase B: Olas Marketplace enricher (always runs — fetches Olas agent metadata)
  startOlasEnricher(sharedPool, { intervalMs: 15 * 60_000, agentsPerCycle: 5, timeoutMs: 10_000 })
  app.log.info('[enrichment] Olas marketplace enricher started (15min cycle)')

  // Phase B: Gas / activity metrics computer
  startGasMetrics(sharedPool, { intervalMs: 15 * 60_000 })
  app.log.info('[enrichment] Gas metrics computer started (15min cycle)')

  // Phase B: Contract interaction analyzer
  startContractAnalyzer(sharedPool, { moralisApiKey, intervalMs: 15 * 60_000, resolveNames: !!moralisApiKey })
  app.log.info('[enrichment] Contract interaction analyzer started (15min cycle)')

  // Plan 3A v2: Fail-fast on missing CURSOR_SECRET
  assertCursorSecret()

  // Plan 3A v2: Register plugins (ORDER MATTERS: auth -> rate-limit -> cache)
  await app.register(authPlugin, { db: client, redis })
  await app.register(rateLimitPlugin, { redis })
  await app.register(cachePlugin, { redis })
  app.log.info('Auth, rate-limit, and cache plugins registered')

  // Plan 3A: Agent + protocol query routes
  registerAgentRoutes(app, client, clickhouse)
  registerProtocolRoutes(app, client)
  registerFeedRoutes(app, clickhouse)
  registerReportRoutes(app, clickhouse)
  registerEconomyRoutes(app, client)
  app.log.info('Agent, protocol, feed, report, and economy routes mounted')

  // Plan 3E: SSE streaming + webhook alert routes
  registerStreamRoutes(app, eventBus)
  registerAlertRoutes(app, client)
  app.log.info('Stream and alert routes mounted')

  // Plan 4B: Self-registration + admin endpoints (resolverProducer may be null without Redpanda)
  registerIdentityRoutes(app, client, resolverProducer as any)
  app.log.info('Identity registration routes mounted')

  const adminKey = process.env.ADMIN_KEY
  if (adminKey) {
    registerAdminRoutes(app, client, resolverProducer, adminKey)
    app.log.info('Identity admin routes mounted')
  }

  // Plan 4B: Lucid-native batch resolver (runs on startup + triggered via admin)
  const lucidResolver = new LucidResolver(client, resolverProducer)
  lucidResolver.run().then((result) => {
    if (result.skipped) {
      app.log.info('Lucid resolver: skipped (another instance running)')
    } else {
      app.log.info(`Lucid resolver: processed=${result.processed} created=${result.created} enriched=${result.enriched} conflicts=${result.conflicts}`)
    }
  }).catch((err) => {
    app.log.error('Lucid resolver startup error:', err)
  })

  // Plan 4B: Clean up expired challenges on startup + every 15 minutes
  cleanupExpiredChallenges(client).then((count) => {
    if (count > 0) app.log.info(`Cleaned up ${count} expired challenges`)
  }).catch(() => {})

  setInterval(() => {
    cleanupExpiredChallenges(client).catch(() => {})
  }, 15 * 60_000)

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
  // Plan 3A v2 resources
  await closeRedis()
  // Plan 2A resources
  await consumer?.disconnect()
  await clickhouse?.close()
  await shutdownTelemetry()
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
