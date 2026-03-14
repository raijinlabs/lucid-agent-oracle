/**
 * Export OpenAPI spec with ALL routes registered (no DB required).
 * Usage: npx tsx scripts/export-openapi.ts > openapi.json
 */
import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import swagger from '@fastify/swagger'
import {
  OracleClickHouse,
  registerDefaultAdapters,
} from '@lucid/oracle-core'
import { registerOracleRoutes } from '../apps/api/src/routes/v1.js'
import { registerAgentRoutes } from '../apps/api/src/routes/agents.js'
import { registerProtocolRoutes } from '../apps/api/src/routes/protocols.js'
import { registerFeedRoutes } from '../apps/api/src/routes/feeds.js'
import { registerReportRoutes } from '../apps/api/src/routes/reports.js'
import { ProblemDetail, CursorQuery, CursorMeta, AgentIdParams, ProtocolIdParams, registerGlobalErrorHandler } from '../apps/api/src/schemas/common.js'
import {
  FeedListResponse,
  FeedDetailResponse,
  FeedMethodologyResponse,
  ReportLatestResponse,
} from '../apps/api/src/schemas/feeds.js'

const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>()

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

// Shared TypeBox schemas
app.addSchema(ProblemDetail)
app.addSchema(CursorQuery)
app.addSchema(CursorMeta)
app.addSchema(AgentIdParams)
app.addSchema(ProtocolIdParams)

registerGlobalErrorHandler(app)

// Stub DB client — routes only need the type shape for schema registration
const stubDb = {} as any

// Register ALL routes (handlers won't be called, just schema registration)
registerOracleRoutes(app)
registerAgentRoutes(app, stubDb, null)
registerProtocolRoutes(app, stubDb)
registerFeedRoutes(app, null)
registerReportRoutes(app, null)

await app.ready()
const spec = app.swagger()
process.stdout.write(JSON.stringify(spec, null, 2))
await app.close()
