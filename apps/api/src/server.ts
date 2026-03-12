import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerOracleRoutes } from './routes/v1.js'

const PORT = parseInt(process.env.PORT ?? '4040', 10)

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: true,
  exposedHeaders: ['X-Request-Id'],
})

// Health check
app.get('/health', async () => ({
  status: 'ok',
  service: 'oracle-economy-api',
  timestamp: new Date().toISOString(),
}))

// NOTE: Auth middleware (resolveTenantIdAsync) deferred to Plan 3.
// Plan 1 serves unauthenticated free-tier endpoints only.
registerOracleRoutes(app)

// Graceful shutdown (Railway convention)
const shutdown = async () => {
  app.log.info('Shutting down...')
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
