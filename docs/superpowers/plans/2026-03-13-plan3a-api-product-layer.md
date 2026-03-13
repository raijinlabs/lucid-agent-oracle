# Plan 3A v2: API Product Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Oracle API from working handlers to a production-grade API product surface with TypeBox schemas, OpenAPI docs, Redis caching, server-side auth/tiering, cursor pagination, rate limiting, and RFC 9457 error contracts.

**Architecture:** Keep the engine (AgentQueryService), replace the chassis. TypeBox is single source of truth for validation, serialization, OpenAPI, and TypeScript types. Plugins (auth, cache, rate-limit) compose via Fastify hooks in strict order: onRequest(auth) -> onRequest(rate-limit) -> preHandler(cache) -> handler -> onSend(cache). Redis-backed with graceful degradation to Postgres-direct on unavailability.

**Tech Stack:** Fastify 5, TypeBox 0.34, @fastify/swagger 9, @fastify/swagger-ui 5, @fastify/rate-limit 10, node-redis 4.7, HMAC-SHA256 signed cursors.

**Spec:** `docs/superpowers/specs/2026-03-13-plan3a-api-product-layer-design.md`

---

## File Structure

### New files

```
apps/api/src/schemas/common.ts          — RFC 9457 errors, cursor pagination, list envelope, ID params, error helper
apps/api/src/schemas/agents.ts          — TypeBox schemas for all 5 agent endpoints
apps/api/src/schemas/protocols.ts       — TypeBox schemas for all 3 protocol endpoints
apps/api/src/plugins/auth.ts            — API key -> tenant/plan resolution, requireTier helper
apps/api/src/plugins/cache.ts           — Redis response cache (preHandler/onSend)
apps/api/src/plugins/rate-limit.ts      — @fastify/rate-limit per-route wrapper
apps/api/src/services/redis.ts          — Redis client singleton + key builders
apps/api/src/utils/cursor.ts            — Signed cursor encode/decode/verify

apps/api/src/__tests__/cursor.test.ts             — Cursor round-trip, signature, tampering (~6 tests)
apps/api/src/__tests__/auth-plugin.test.ts        — Auth plugin unit tests (~5 tests)
apps/api/src/__tests__/cache-plugin.test.ts       — Cache plugin unit tests (~4 tests)
apps/api/src/__tests__/rate-limit-plugin.test.ts  — Rate limit plugin tests (~3 tests)
```

### Modified files

```
apps/api/package.json                          — Add 6 new dependencies
apps/api/src/services/agent-query.ts           — Cursor support for search/leaderboard/activity
apps/api/src/routes/agents.ts                  — FULL REWRITE: TypeBox schemas, plugin config, thin handlers
apps/api/src/routes/protocols.ts               — FULL REWRITE: 3 endpoints, TypeBox schemas, protocol list migrated from v1.ts
apps/api/src/routes/v1.ts                      — RFC 9457 errors, remove protocol list endpoint
apps/api/src/routes/identity-registration.ts   — Add cache invalidation on registration success
apps/api/src/routes/identity-admin.ts          — Add cache invalidation on conflict resolution
apps/api/src/services/lucid-resolver.ts        — Add cache invalidation after resolver run
apps/api/src/server.ts                         — TypeBox type provider, Swagger, plugins, Redis, CORS, shutdown

apps/api/src/__tests__/agent-routes.test.ts    — Update assertions for new response shapes + auth
apps/api/src/__tests__/protocol-routes.test.ts — Update assertions + add protocol list test
apps/api/src/__tests__/api.test.ts             — Update error format assertions
apps/api/src/__tests__/agent-query.test.ts     — Add cursor return value tests
```

### Dependencies between files

```
schemas/common.ts          <- (imported by) schemas/agents.ts, schemas/protocols.ts, plugins/*, routes/*
services/redis.ts          <- plugins/auth.ts, plugins/cache.ts, plugins/rate-limit.ts
utils/cursor.ts            <- services/agent-query.ts, routes/agents.ts
plugins/auth.ts            <- server.ts (registration)
plugins/cache.ts           <- server.ts (registration)
plugins/rate-limit.ts      <- server.ts (registration)
schemas/agents.ts          <- routes/agents.ts
schemas/protocols.ts       <- routes/protocols.ts
services/agent-query.ts    <- routes/agents.ts, routes/protocols.ts
```

### Parallel execution opportunities

After Task 1 (deps install):
- Tasks 2, 3, 4 can run in parallel (no interdependencies)

After Tasks 2-4 complete:
- Tasks 5, 6, 8, 9 can run in parallel (all depend only on common.ts + redis.ts)
- Task 7 (rate-limit) depends on Task 5 (auth plugin) because rate-limit reads `request.tenant` type

After Tasks 5-9 complete:
- Tasks 10, 11, 12 can run in parallel (routes + service changes)

Tasks 13-14 must run after all routes are done.

---

## Chunk 1: Foundation

### Task 1: Install dependencies

**Files:**
- Modify: `apps/api/package.json`

- [ ] **Step 1: Add dependencies to package.json**

```json
{
  "dependencies": {
    "@lucid/oracle-core": "*",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/swagger": "^9.0.0",
    "@fastify/swagger-ui": "^5.0.0",
    "@fastify/rate-limit": "^10.0.0",
    "@fastify/type-provider-typebox": "^5.0.0",
    "@sinclair/typebox": "^0.34.0",
    "fastify-plugin": "^5.0.0",
    "redis": "^4.7.0",
    "pino": "^9.0.0",
    "nanoid": "^5.0.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `cd C:\lucid-agent-oracle && npm install`
Expected: Clean install, no peer dep warnings for added packages.

- [ ] **Step 3: Verify existing tests still pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All existing tests pass. This is our regression baseline.

- [ ] **Step 4: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/package.json package-lock.json
git commit -m "feat(oracle-api): add TypeBox, Swagger, Redis, rate-limit dependencies for Plan 3A v2"
```

---

### Task 2: Shared schemas — `schemas/common.ts`

**Files:**
- Create: `apps/api/src/schemas/common.ts`

- [ ] **Step 1: Create schemas/common.ts with all shared TypeBox schemas + error helper**

```typescript
import { Type, Static, TSchema } from '@sinclair/typebox'
import type { FastifyReply } from 'fastify'

// ---------------------------------------------------------------------------
// RFC 9457 Problem Details
// ---------------------------------------------------------------------------

export const ProblemDetail = Type.Object({
  type: Type.String({ description: 'URI reference identifying the problem type' }),
  title: Type.String({ description: 'Short human-readable summary' }),
  status: Type.Integer({ description: 'HTTP status code' }),
  detail: Type.Optional(Type.String({ description: 'Human-readable explanation' })),
  instance: Type.Optional(Type.String({ description: 'URI of the request that caused the problem' })),
  code: Type.Optional(Type.String({ description: 'Machine-readable error code' })),
}, { $id: 'ProblemDetail' })

export type ProblemDetailType = Static<typeof ProblemDetail>

const ERROR_BASE = 'https://oracle.lucid.foundation/errors'

/** Send an RFC 9457 Problem Details error response. */
export function sendProblem(
  reply: FastifyReply,
  status: number,
  opts: { type: string; title: string; detail?: string; instance?: string; code?: string },
): FastifyReply {
  return reply
    .status(status)
    .header('content-type', 'application/problem+json')
    .send({
      type: `${ERROR_BASE}/${opts.type}`,
      title: opts.title,
      status,
      detail: opts.detail,
      instance: opts.instance,
      code: opts.code,
    })
}

// ---------------------------------------------------------------------------
// Cursor Pagination
// ---------------------------------------------------------------------------

export const CursorQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String({ description: 'Opaque cursor from previous response' })),
}, { $id: 'CursorQuery' })

export type CursorQueryType = Static<typeof CursorQuery>

export const CursorMeta = Type.Object({
  next_cursor: Type.Union([Type.String(), Type.Null()]),
  has_more: Type.Boolean(),
  limit: Type.Integer(),
}, { $id: 'CursorMeta' })

export type CursorMetaType = Static<typeof CursorMeta>

/** Generic paginated list response. */
export function PaginatedList<T extends TSchema>(itemSchema: T, $id: string) {
  return Type.Object({
    data: Type.Array(itemSchema),
    pagination: CursorMeta,
  }, { $id })
}

// ---------------------------------------------------------------------------
// ID Parameters
// ---------------------------------------------------------------------------

export const AgentIdParams = Type.Object({
  id: Type.String({
    minLength: 4,
    maxLength: 30,
    pattern: '^ae_[a-zA-Z0-9_-]+$',
    description: 'Agent entity ID (e.g., ae_7f3k9x2m)',
  }),
}, { $id: 'AgentIdParams' })

export type AgentIdParamsType = Static<typeof AgentIdParams>

export const ProtocolIdParams = Type.Object({
  id: Type.String({
    minLength: 2,
    maxLength: 50,
    pattern: '^[a-z0-9_-]+$',
    description: 'Protocol identifier (e.g., lucid, erc8004). Validated against PROTOCOL_REGISTRY at runtime.',
  }),
}, { $id: 'ProtocolIdParams' })

export type ProtocolIdParamsType = Static<typeof ProtocolIdParams>

// ---------------------------------------------------------------------------
// Data Envelope (non-paginated)
// ---------------------------------------------------------------------------

export function DataEnvelope<T extends TSchema>(dataSchema: T, $id: string) {
  return Type.Object({
    data: dataSchema,
  }, { $id })
}

// ---------------------------------------------------------------------------
// Global Error Handler (RFC 9457 for ALL errors)
// ---------------------------------------------------------------------------

/**
 * Register on Fastify instance to catch Ajv validation errors, rate-limit 429s,
 * and any unhandled errors — ensures all error responses are RFC 9457 Problem Details
 * with Content-Type: application/problem+json.
 */
export function registerGlobalErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode ?? 500

    // Ajv validation errors
    if (error.validation) {
      return reply
        .status(400)
        .header('content-type', 'application/problem+json')
        .send({
          type: `${ERROR_BASE}/validation-error`,
          title: 'Validation error',
          status: 400,
          detail: error.message,
          instance: request.url,
        })
    }

    // Rate limit errors (from @fastify/rate-limit)
    if (status === 429) {
      return reply
        .status(429)
        .header('content-type', 'application/problem+json')
        .send({
          type: `${ERROR_BASE}/rate-limited`,
          title: 'Rate limit exceeded',
          status: 429,
          detail: error.message,
          instance: request.url,
        })
    }

    // All other errors
    return reply
      .status(status)
      .header('content-type', 'application/problem+json')
      .send({
        type: `${ERROR_BASE}/${status >= 500 ? 'internal-error' : 'bad-request'}`,
        title: error.message || 'Internal server error',
        status,
        instance: request.url,
      })
  })
}
```

**NOTE:** Import `FastifyInstance` at the top: `import type { FastifyInstance, FastifyReply } from 'fastify'`

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd C:\lucid-agent-oracle && npx tsc --noEmit apps/api/src/schemas/common.ts 2>&1 | head -20`

If the project doesn't support single-file tsc, run: `cd C:\lucid-agent-oracle && npx tsc --noEmit 2>&1 | head -30`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/schemas/common.ts
git commit -m "feat(oracle-api): add shared TypeBox schemas — ProblemDetail, cursor, ID params, envelopes"
```

---

### Task 3: Redis client — `services/redis.ts`

**Files:**
- Create: `apps/api/src/services/redis.ts`

- [ ] **Step 1: Create redis.ts — thin singleton + key builders**

```typescript
import { createClient, type RedisClientType } from 'redis'
import { createHash } from 'node:crypto'

let client: RedisClientType | null = null

export async function initRedis(url?: string): Promise<RedisClientType | null> {
  if (!url) return null // graceful: no REDIS_URL = degraded mode
  client = createClient({ url })
  client.on('error', (err: Error) => console.error('[redis]', err.message))
  await client.connect()
  return client
}

export function getRedis(): RedisClientType | null {
  return client
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => {})
    client = null
  }
}

/** Cache key builders. API key hashed with SHA-256 for security. */
export const keys = {
  apiKey: (raw: string) =>
    `oracle:apikey:${createHash('sha256').update(raw).digest('hex')}`,
  agentProfile: (id: string) =>
    `oracle:agent:profile:${id}`,
  agentMetrics: (id: string, plan: string) =>
    `oracle:agent:metrics:${id}:${plan}`,
  leaderboard: (version: number, sort: string, cursor: string, plan: string) =>
    `oracle:lb:v${version}:${sort}:${cursor}:${plan}`,
  leaderboardVersion: () =>
    `oracle:lb:version`,
  protocolList: () =>
    `oracle:protocols`,
  protocolDetail: (id: string) =>
    `oracle:protocol:${id}`,
  protocolMetrics: (id: string, plan: string) =>
    `oracle:protocol:metrics:${id}:${plan}`,
}

// ---------------------------------------------------------------------------
// Cache invalidation helpers
// ---------------------------------------------------------------------------

import { PROTOCOL_REGISTRY } from './agent-query.js'

/** Invalidate agent caches after registration or conflict resolution. */
export async function invalidateAgentCaches(...agentIds: string[]): Promise<void> {
  if (!client) return
  const pipeline = client.multi()
  for (const id of agentIds) {
    pipeline.del(keys.agentProfile(id))
    pipeline.del(keys.agentMetrics(id, 'free'))
    pipeline.del(keys.agentMetrics(id, 'pro'))
    pipeline.del(keys.agentMetrics(id, 'growth'))
  }
  // Increment leaderboard version — old keys expire via TTL
  pipeline.incr(keys.leaderboardVersion())
  await pipeline.exec().catch(() => {})
  // Update in-memory version for synchronous cache key generation
  const newVersion = await client.get(keys.leaderboardVersion()).catch(() => null)
  if (newVersion) (globalThis as any).__lbVersion = parseInt(newVersion, 10)
}

/** Invalidate protocol caches after resolver run. */
export async function invalidateProtocolCaches(): Promise<void> {
  if (!client) return
  const pipeline = client.multi()
  pipeline.del(keys.protocolList())
  for (const id of Object.keys(PROTOCOL_REGISTRY)) {
    pipeline.del(keys.protocolDetail(id))
    pipeline.del(keys.protocolMetrics(id, 'free'))
    pipeline.del(keys.protocolMetrics(id, 'pro'))
    pipeline.del(keys.protocolMetrics(id, 'growth'))
  }
  await pipeline.exec().catch(() => {})
}

/** Load current leaderboard version into memory (call at startup). */
export async function loadLeaderboardVersion(): Promise<void> {
  if (!client) return
  const version = await client.get(keys.leaderboardVersion()).catch(() => null)
  ;(globalThis as any).__lbVersion = version ? parseInt(version, 10) : 0
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd C:\lucid-agent-oracle && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/services/redis.ts
git commit -m "feat(oracle-api): add Redis client singleton with SHA-256 hashed key builders"
```

---

### Task 4: Cursor utilities — `utils/cursor.ts` + tests

**Files:**
- Create: `apps/api/src/utils/cursor.ts`
- Create: `apps/api/src/__tests__/cursor.test.ts`

- [ ] **Step 1: Write cursor.test.ts**

```typescript
import { describe, it, expect, beforeAll } from 'vitest'

// Set secret before importing cursor module
process.env.CURSOR_SECRET = 'test-cursor-secret-32chars-long!'

// Dynamic import so env is set first
const { encodeCursor, decodeCursor, assertCursorSecret } = await import('../utils/cursor.js')

describe('Cursor utilities', () => {
  it('assertCursorSecret does not throw when secret is set', () => {
    expect(() => assertCursorSecret()).not.toThrow()
  })

  it('encode then decode round-trips correctly', () => {
    const cursor = encodeCursor('2026-03-12T00:00:00Z', 'ae_abc123')
    expect(typeof cursor).toBe('string')

    const decoded = decodeCursor(cursor)
    expect(decoded).not.toBeNull()
    expect(decoded!.s).toBe('2026-03-12T00:00:00Z')
    expect(decoded!.id).toBe('ae_abc123')
    expect(decoded!.v).toBe(1)
  })

  it('encode with numeric sort value round-trips', () => {
    const cursor = encodeCursor(42, 'ae_xyz')
    const decoded = decodeCursor(cursor)
    expect(decoded).not.toBeNull()
    expect(decoded!.s).toBe(42)
  })

  it('rejects tampered cursor (modified payload)', () => {
    const cursor = encodeCursor('2026-03-12', 'ae_1')
    // Decode base64url, tamper, re-encode
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    raw.id = 'ae_tampered'
    const tampered = Buffer.from(JSON.stringify(raw)).toString('base64url')
    expect(decodeCursor(tampered)).toBeNull()
  })

  it('rejects completely invalid cursor string', () => {
    expect(decodeCursor('not-a-cursor')).toBeNull()
    expect(decodeCursor('')).toBeNull()
  })

  it('rejects cursor with wrong version', () => {
    const cursor = encodeCursor('val', 'ae_1')
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    raw.v = 99
    // Re-sign would be needed, so just test that wrong version is rejected
    const modified = Buffer.from(JSON.stringify(raw)).toString('base64url')
    expect(decodeCursor(modified)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/cursor.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL — module `../utils/cursor.js` not found.

- [ ] **Step 3: Implement utils/cursor.ts**

```typescript
import { createHmac } from 'node:crypto'

interface CursorPayload {
  v: number
  s: string | number
  id: string
}

function getSecrets(): { current: string; previous?: string } {
  const current = process.env.CURSOR_SECRET
  if (!current) throw new Error('CURSOR_SECRET env var is required')
  return { current, previous: process.env.CURSOR_SECRET_PREV }
}

/** Call at startup to fail-fast if CURSOR_SECRET is missing. */
export function assertCursorSecret(): void {
  getSecrets()
}

function sign(payload: CursorPayload, secret: string): string {
  const data = `${payload.v}:${String(payload.s)}:${payload.id}`
  return createHmac('sha256', secret).update(data).digest('base64url')
}

export function encodeCursor(s: string | number, id: string): string {
  const { current } = getSecrets()
  const payload: CursorPayload = { v: 1, s, id }
  const sig = sign(payload, current)
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString('base64url')
}

export function decodeCursor(cursor: string): CursorPayload | null {
  if (!cursor) return null
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as CursorPayload & { sig: string }
    if (raw.v !== 1) return null

    const { current, previous } = getSecrets()

    // Verify with current secret
    if (sign(raw, current) === raw.sig) {
      return { v: raw.v, s: raw.s, id: raw.id }
    }

    // Dual-key validation for rotation
    if (previous && sign(raw, previous) === raw.sig) {
      return { v: raw.v, s: raw.s, id: raw.id }
    }

    return null // invalid signature
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/cursor.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/utils/cursor.ts apps/api/src/__tests__/cursor.test.ts
git commit -m "feat(oracle-api): add HMAC-signed cursor encode/decode with dual-key rotation support"
```

---

## Chunk 2: Plugins + Domain Schemas

### Task 5: Auth plugin — `plugins/auth.ts` + tests

**Files:**
- Create: `apps/api/src/plugins/auth.ts`
- Create: `apps/api/src/__tests__/auth-plugin.test.ts`

- [ ] **Step 1: Write auth-plugin.test.ts**

```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'

// We test the auth plugin by registering it on a Fastify instance with a mock DB
describe('Auth plugin', () => {
  it('decorates request.tenant with free plan when no x-api-key', async () => {
    const app = Fastify()
    const { authPlugin } = await import('../plugins/auth.js')
    await app.register(authPlugin, { db: { query: vi.fn() } as any })

    app.get('/test', async (request) => {
      return { tenant: (request as any).tenant }
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/test' })
    const body = res.json()
    expect(body.tenant).toEqual({ id: null, plan: 'free' })
    await app.close()
  })

  it('resolves tenant from DB when x-api-key is provided and not cached', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'tenant_123', plan: 'pro' }],
      }),
    }

    const app = Fastify()
    const { authPlugin } = await import('../plugins/auth.js')
    // Pass null redis to skip cache
    await app.register(authPlugin, { db: mockDb as any, redis: null })

    app.get('/test', async (request) => {
      return { tenant: (request as any).tenant }
    })
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-api-key': 'my-api-key-123' },
    })
    const body = res.json()
    expect(body.tenant.id).toBe('tenant_123')
    expect(body.tenant.plan).toBe('pro')
    await app.close()
  })

  it('returns 401 for invalid API key', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }

    const app = Fastify()
    const { authPlugin } = await import('../plugins/auth.js')
    await app.register(authPlugin, { db: mockDb as any, redis: null })

    app.get('/test', async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-api-key': 'invalid-key' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().type).toContain('invalid-api-key')
    await app.close()
  })

  it('requireTier returns 403 when plan is insufficient', async () => {
    const app = Fastify()
    const { authPlugin, requireTier } = await import('../plugins/auth.js')
    await app.register(authPlugin, { db: { query: vi.fn() } as any })

    app.get('/pro-only', { preHandler: [requireTier('pro')] }, async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/pro-only' })
    expect(res.statusCode).toBe(403)
    expect(res.json().type).toContain('tier-required')
    await app.close()
  })

  it('requireTier passes when plan meets minimum', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValue({
        rows: [{ id: 'tenant_1', plan: 'pro' }],
      }),
    }

    const app = Fastify()
    const { authPlugin, requireTier } = await import('../plugins/auth.js')
    await app.register(authPlugin, { db: mockDb as any, redis: null })

    app.get('/pro-only', { preHandler: [requireTier('pro')] }, async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/pro-only',
      headers: { 'x-api-key': 'valid-pro-key' },
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/auth-plugin.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL — module `../plugins/auth.js` not found.

- [ ] **Step 3: Implement plugins/auth.ts**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { DbClient } from '@lucid/oracle-core'
import type { RedisClientType } from 'redis'
import { keys } from '../services/redis.js'

declare module 'fastify' {
  interface FastifyRequest {
    tenant: { id: string | null; plan: string }
  }
}

interface AuthPluginOpts {
  db: DbClient
  redis?: RedisClientType | null
}

const CACHE_TTL = 300 // 5 minutes

async function authPluginFn(app: FastifyInstance, opts: AuthPluginOpts): Promise<void> {
  const { db, redis } = opts

  app.decorateRequest('tenant', { id: null, plan: 'free' })

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = request.headers['x-api-key'] as string | undefined

    if (!apiKey) {
      request.tenant = { id: null, plan: 'free' }
      return
    }

    // Try Redis cache first
    if (redis) {
      try {
        const cached = await redis.get(keys.apiKey(apiKey))
        if (cached) {
          request.tenant = JSON.parse(cached)
          return
        }
      } catch {
        // Redis unavailable — fall through to DB
      }
    }

    // DB lookup
    const { rows } = await db.query(
      `SELECT id, plan FROM gateway_tenants WHERE api_key = $1 AND active = true LIMIT 1`,
      [apiKey],
    )

    if (rows.length === 0) {
      return reply
        .status(401)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://oracle.lucid.foundation/errors/invalid-api-key',
          title: 'Invalid API key',
          status: 401,
          detail: 'The provided API key is not valid or has been deactivated.',
          instance: request.url,
        })
    }

    const tenant = { id: rows[0].id as string, plan: (rows[0].plan as string) ?? 'free' }
    request.tenant = tenant

    // Cache in Redis
    if (redis) {
      redis.setEx(keys.apiKey(apiKey), CACHE_TTL, JSON.stringify(tenant)).catch(() => {})
    }
  })
}

export const authPlugin = fp(authPluginFn, {
  name: 'oracle-auth',
  fastify: '5.x',
})

// ---------------------------------------------------------------------------
// Tier gate helper
// ---------------------------------------------------------------------------

function tierRank(plan: string): number {
  return ({ free: 0, pro: 1, growth: 2 } as Record<string, number>)[plan] ?? 0
}

export function requireTier(minTier: 'pro' | 'growth') {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const plan = request.tenant.plan
    if (tierRank(plan) < tierRank(minTier)) {
      return reply
        .status(403)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://oracle.lucid.foundation/errors/tier-required',
          title: 'Insufficient tier',
          status: 403,
          detail: `This endpoint requires ${minTier} tier or above.`,
          instance: request.url,
        })
    }
  }
}
```

**NOTE:** This file uses `fastify-plugin` (`fp`) to break encapsulation — the `request.tenant` decoration propagates to all routes. Check if `fastify-plugin` is already available (it's a transitive dep of Fastify). If not, add it to `package.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/auth-plugin.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All 5 tests PASS.

- [ ] **Step 5: Verify all existing tests still pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass. Auth plugin doesn't break existing routes.

- [ ] **Step 6: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/plugins/auth.ts apps/api/src/__tests__/auth-plugin.test.ts
git commit -m "feat(oracle-api): add auth plugin — API key -> tenant/plan resolution with Redis cache"
```

---

### Task 6: Cache plugin — `plugins/cache.ts` + tests

**Files:**
- Create: `apps/api/src/plugins/cache.ts`
- Create: `apps/api/src/__tests__/cache-plugin.test.ts`

- [ ] **Step 1: Write cache-plugin.test.ts**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

describe('Cache plugin', () => {
  it('returns cached response on HIT with X-Cache: HIT header', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ data: { id: 'ae_1' } })),
      setEx: vi.fn(),
    }

    const app = Fastify()
    const { cachePlugin } = await import('../plugins/cache.js')
    await app.register(cachePlugin, { redis: mockRedis as any })

    app.get('/test', {
      config: { cache: { ttl: 60, key: () => 'test-key' } },
    } as any, async () => {
      return { data: { id: 'ae_should_not_reach' } }
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('HIT')
    expect(res.json().data.id).toBe('ae_1')
    await app.close()
  })

  it('stores response on MISS with X-Cache: MISS header', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      setEx: vi.fn().mockResolvedValue('OK'),
    }

    const app = Fastify()
    const { cachePlugin } = await import('../plugins/cache.js')
    await app.register(cachePlugin, { redis: mockRedis as any })

    app.get('/test', {
      config: { cache: { ttl: 30, key: () => 'test-key-2' } },
    } as any, async () => {
      return { data: { id: 'ae_fresh' } }
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBe('MISS')
    expect(mockRedis.setEx).toHaveBeenCalledWith('test-key-2', 30, expect.any(String))
    await app.close()
  })

  it('does not cache non-200 responses', async () => {
    const mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      setEx: vi.fn(),
    }

    const app = Fastify()
    const { cachePlugin } = await import('../plugins/cache.js')
    await app.register(cachePlugin, { redis: mockRedis as any })

    app.get('/test', {
      config: { cache: { ttl: 60, key: () => 'test-key-3' } },
    } as any, async (_req: any, reply: any) => {
      return reply.status(404).send({ error: 'not found' })
    })
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(404)
    expect(mockRedis.setEx).not.toHaveBeenCalled()
    await app.close()
  })

  it('skips cache entirely when no config.cache on route', async () => {
    const mockRedis = {
      get: vi.fn(),
      setEx: vi.fn(),
    }

    const app = Fastify()
    const { cachePlugin } = await import('../plugins/cache.js')
    await app.register(cachePlugin, { redis: mockRedis as any })

    app.get('/no-cache', async () => ({ data: 'fresh' }))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/no-cache' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-cache']).toBeUndefined()
    expect(mockRedis.get).not.toHaveBeenCalled()
    await app.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/cache-plugin.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: FAIL — module `../plugins/cache.js` not found.

- [ ] **Step 3: Implement plugins/cache.ts**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { RedisClientType } from 'redis'

interface CacheConfig {
  ttl: number
  key: (req: FastifyRequest) => string
}

declare module 'fastify' {
  interface FastifyContextConfig {
    cache?: CacheConfig
  }
}

interface CachePluginOpts {
  redis: RedisClientType | null
}

async function cachePluginFn(app: FastifyInstance, opts: CachePluginOpts): Promise<void> {
  const { redis } = opts

  // preHandler: serve from cache if HIT
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const cacheConfig = request.routeOptions.config?.cache as CacheConfig | undefined
    if (!cacheConfig || !redis) return
    if (request.method !== 'GET' && request.method !== 'HEAD') return

    try {
      const cacheKey = cacheConfig.key(request)
      const cached = await redis.get(cacheKey)
      if (cached) {
        reply.header('x-cache', 'HIT')
        reply.header('content-type', 'application/json')
        return reply.send(cached)
      }
    } catch {
      // Redis error — skip cache, proceed to handler
    }
  })

  // onSend: store response in cache on MISS (200 GET/HEAD only)
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: string) => {
    const cacheConfig = request.routeOptions.config?.cache as CacheConfig | undefined
    if (!cacheConfig || !redis) return payload
    if (request.method !== 'GET' && request.method !== 'HEAD') return payload
    if (reply.statusCode !== 200) return payload
    if (reply.getHeader('x-cache') === 'HIT') return payload // already served from cache

    try {
      const cacheKey = cacheConfig.key(request)
      reply.header('x-cache', 'MISS')
      await redis.setEx(cacheKey, cacheConfig.ttl, typeof payload === 'string' ? payload : JSON.stringify(payload))
    } catch {
      // Redis error — skip caching
    }

    return payload
  })
}

export const cachePlugin = fp(cachePluginFn, {
  name: 'oracle-cache',
  fastify: '5.x',
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/cache-plugin.test.ts --reporter=verbose 2>&1 | tail -15`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/plugins/cache.ts apps/api/src/__tests__/cache-plugin.test.ts
git commit -m "feat(oracle-api): add cache plugin — Redis preHandler/onSend with X-Cache headers"
```

---

### Task 7: Rate limit plugin — `plugins/rate-limit.ts` + tests

**Files:**
- Create: `apps/api/src/plugins/rate-limit.ts`
- Create: `apps/api/src/__tests__/rate-limit-plugin.test.ts`

- [ ] **Step 1: Check @fastify/rate-limit docs for per-route config API**

Use context7 or check the package README to verify:
- How to set per-route `max` as a function of `request`
- How to set `keyGenerator` per route
- How to customize the 429 error response body
- Whether `config.rateLimit` on routes is the correct pattern

Key things to verify: `@fastify/rate-limit` supports `routeConfig` option or per-route `config.rateLimit`. The design intent is per-plan dynamic max and custom key generation.

- [ ] **Step 2: Implement plugins/rate-limit.ts**

```typescript
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { RedisClientType } from 'redis'

interface RateLimitPluginOpts {
  redis: RedisClientType | null
}

async function rateLimitPluginFn(app: FastifyInstance, opts: RateLimitPluginOpts): Promise<void> {
  const { redis } = opts

  // NOTE: Verify the exact @fastify/rate-limit API for Redis store integration.
  // node-redis v4 may need an adapter. Check docs.
  // If @fastify/rate-limit doesn't natively support node-redis v4,
  // use the built-in in-memory store and note Redis rate-limit as Plan 3B.

  await app.register(rateLimit, {
    global: false, // only apply to routes that opt-in via config
    max: 60,       // default max (overridden per-route)
    timeWindow: 60_000,
    // Redis store if available
    ...(redis ? { redis } : {}),
    keyGenerator: (request) => {
      return (request as any).tenant?.id ?? request.ip
    },
    errorResponseBuilder: (_request, context) => ({
      type: 'https://oracle.lucid.foundation/errors/rate-limited',
      title: 'Rate limit exceeded',
      status: 429,
      detail: `Rate limit exceeded. Try again in ${Math.ceil((context.ttl ?? 60000) / 1000)} seconds.`,
    }),
  })
}

export const rateLimitPlugin = fp(rateLimitPluginFn, {
  name: 'oracle-rate-limit',
  fastify: '5.x',
})
```

**IMPORTANT:** The implementer MUST verify the @fastify/rate-limit API shape against current docs. The Redis store integration for node-redis v4 may need `@fastify/rate-limit`'s `RedisStore` or a compat adapter. **Decision boundary:** If `node-redis` v4 is not directly compatible with `@fastify/rate-limit`'s Redis store, use the built-in in-memory store for Plan 3A and note Redis-backed rate limiting as a Plan 3B task. The per-route / per-plan / custom-key design intent is fixed regardless of store backend.

- [ ] **Step 3: Write rate-limit-plugin.test.ts**

```typescript
import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

describe('Rate limit plugin', () => {
  it('does not rate-limit routes without config (global: false)', async () => {
    const app = Fastify()

    // Mock auth plugin to provide request.tenant
    await app.register(fp(async (a: any) => {
      a.decorateRequest('tenant', { id: null, plan: 'free' })
    }))

    const { rateLimitPlugin } = await import('../plugins/rate-limit.js')
    await app.register(rateLimitPlugin, { redis: null })

    app.get('/no-limit', async () => ({ ok: true }))
    await app.ready()

    // Make several requests — all should succeed
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/no-limit' })
      expect(res.statusCode).toBe(200)
    }
    await app.close()
  })

  it('returns RFC 9457 body on 429 when rate limited', async () => {
    const app = Fastify()

    await app.register(fp(async (a: any) => {
      a.decorateRequest('tenant', { id: null, plan: 'free' })
    }))

    const { rateLimitPlugin } = await import('../plugins/rate-limit.js')
    await app.register(rateLimitPlugin, { redis: null })

    // Register a route with very low max
    app.get('/limited', {
      config: { rateLimit: { max: 1, timeWindow: 60000 } },
    } as any, async () => ({ ok: true }))
    await app.ready()

    // First request succeeds
    const res1 = await app.inject({ method: 'GET', url: '/limited' })
    expect(res1.statusCode).toBe(200)

    // Second request is rate limited
    const res2 = await app.inject({ method: 'GET', url: '/limited' })
    expect(res2.statusCode).toBe(429)
    const body = res2.json()
    expect(body.type).toContain('rate-limited')
    expect(body.status).toBe(429)
    await app.close()
  })

  it('uses tenant ID as key when available', async () => {
    const app = Fastify()

    await app.register(fp(async (a: any) => {
      a.decorateRequest('tenant', { id: 'tenant_123', plan: 'pro' })
    }))

    const { rateLimitPlugin } = await import('../plugins/rate-limit.js')
    await app.register(rateLimitPlugin, { redis: null })

    app.get('/keyed', {
      config: { rateLimit: { max: 100, timeWindow: 60000 } },
    } as any, async () => ({ ok: true }))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/keyed' })
    expect(res.statusCode).toBe(200)
    // Rate limit headers should be present
    expect(res.headers['x-ratelimit-limit']).toBeDefined()
    await app.close()
  })
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/rate-limit-plugin.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/plugins/rate-limit.ts apps/api/src/__tests__/rate-limit-plugin.test.ts
git commit -m "feat(oracle-api): add rate-limit plugin wrapping @fastify/rate-limit with per-plan limits"
```

---

### Task 8: Agent schemas — `schemas/agents.ts`

**Files:**
- Create: `apps/api/src/schemas/agents.ts`

- [ ] **Step 1: Create schemas/agents.ts with all TypeBox schemas for 5 agent endpoints**

```typescript
import { Type, Static } from '@sinclair/typebox'
import { PaginatedList, DataEnvelope, CursorQuery, AgentIdParams } from './common.js'

// ---------------------------------------------------------------------------
// Shared agent sub-schemas
// ---------------------------------------------------------------------------

const Wallet = Type.Object({
  chain: Type.String(),
  address: Type.String(),
  link_type: Type.String(),
  confidence: Type.Number(),
})

const IdentityLink = Type.Object({
  protocol: Type.String(),
  protocol_id: Type.String(),
  link_type: Type.String(),
  confidence: Type.Number(),
})

const Reputation = Type.Union([
  Type.Object({
    score: Type.Number(),
    updated_at: Type.String(),
  }),
  Type.Null(),
])

// ---------------------------------------------------------------------------
// GET /v1/oracle/agents/:id
// ---------------------------------------------------------------------------

export const AgentProfile = Type.Object({
  id: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  erc8004_id: Type.Union([Type.String(), Type.Null()]),
  lucid_tenant: Type.Union([Type.String(), Type.Null()]),
  reputation: Reputation,
  wallets: Type.Array(Wallet),
  protocols: Type.Array(IdentityLink),
  stats: Type.Object({
    wallet_count: Type.Integer(),
    protocol_count: Type.Integer(),
    evidence_count: Type.Integer(),
  }),
  created_at: Type.String(),
  updated_at: Type.String(),
}, { $id: 'AgentProfile' })

export type AgentProfileType = Static<typeof AgentProfile>

export const AgentProfileResponse = DataEnvelope(AgentProfile, 'AgentProfileResponse')

// ---------------------------------------------------------------------------
// GET /v1/oracle/agents/search
// ---------------------------------------------------------------------------

export const AgentSearchQuery = Type.Intersect([
  CursorQuery,
  Type.Object({
    wallet: Type.Optional(Type.String()),
    chain: Type.Optional(Type.String()),
    protocol: Type.Optional(Type.String()),
    protocol_id: Type.Optional(Type.String()),
    erc8004_id: Type.Optional(Type.String()),
    q: Type.Optional(Type.String({ maxLength: 200 })),
  }),
], { $id: 'AgentSearchQuery' })

export type AgentSearchQueryType = Static<typeof AgentSearchQuery>

const AgentSearchItem = Type.Object({
  id: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  erc8004_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
})

export const AgentSearchResponse = PaginatedList(AgentSearchItem, 'AgentSearchResponse')

// ---------------------------------------------------------------------------
// GET /v1/oracle/agents/leaderboard
// ---------------------------------------------------------------------------

export const LeaderboardQuery = Type.Intersect([
  CursorQuery,
  Type.Object({
    sort: Type.Optional(Type.Union([
      Type.Literal('wallet_count'),
      Type.Literal('protocol_count'),
      Type.Literal('evidence_count'),
      Type.Literal('newest'),
    ], { default: 'wallet_count' })),
  }),
], { $id: 'LeaderboardQuery' })

export type LeaderboardQueryType = Static<typeof LeaderboardQuery>

const LeaderboardItem = Type.Object({
  id: Type.String(),
  display_name: Type.Union([Type.String(), Type.Null()]),
  erc8004_id: Type.Union([Type.String(), Type.Null()]),
  wallet_count: Type.Integer(),
  protocol_count: Type.Integer(),
  evidence_count: Type.Integer(),
  created_at: Type.String(),
})

export const LeaderboardResponse = PaginatedList(LeaderboardItem, 'LeaderboardResponse')

// ---------------------------------------------------------------------------
// GET /v1/oracle/agents/:id/metrics (Pro)
// ---------------------------------------------------------------------------

export const AgentMetricsResponse = DataEnvelope(
  Type.Object({
    agent_id: Type.String(),
    wallets: Type.Object({
      total: Type.Integer(),
      by_chain: Type.Record(Type.String(), Type.Integer()),
      by_link_type: Type.Record(Type.String(), Type.Integer()),
    }),
    evidence: Type.Object({
      total: Type.Integer(),
      by_type: Type.Record(Type.String(), Type.Integer()),
    }),
    protocols: Type.Object({
      total: Type.Integer(),
      list: Type.Array(Type.String()),
    }),
    conflicts: Type.Object({
      active: Type.Integer(),
      resolved: Type.Integer(),
    }),
    first_seen: Type.String(),
    last_active: Type.String(),
  }),
  'AgentMetricsResponse',
)

// ---------------------------------------------------------------------------
// GET /v1/oracle/agents/:id/activity (Pro)
// ---------------------------------------------------------------------------

export const ActivityQuery = Type.Intersect([
  CursorQuery,
], { $id: 'ActivityQuery' })

const ActivityEvent = Type.Object({
  type: Type.Union([
    Type.Literal('evidence_added'),
    Type.Literal('conflict_opened'),
    Type.Literal('wallet_linked'),
  ]),
  timestamp: Type.String(),
  detail: Type.Record(Type.String(), Type.Unknown()),
})

export const ActivityResponse = PaginatedList(ActivityEvent, 'ActivityResponse')
```

- [ ] **Step 2: Verify it compiles**

Run: `cd C:\lucid-agent-oracle && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/schemas/agents.ts
git commit -m "feat(oracle-api): add TypeBox schemas for all 5 agent endpoints"
```

---

### Task 9: Protocol schemas — `schemas/protocols.ts`

**Files:**
- Create: `apps/api/src/schemas/protocols.ts`

- [ ] **Step 1: Create schemas/protocols.ts**

```typescript
import { Type } from '@sinclair/typebox'
import { DataEnvelope } from './common.js'

// ---------------------------------------------------------------------------
// Shared protocol sub-schemas
// ---------------------------------------------------------------------------

const ProtocolSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  chains: Type.Array(Type.String()),
  status: Type.String(),
})

// ---------------------------------------------------------------------------
// GET /v1/oracle/protocols
// ---------------------------------------------------------------------------

export const ProtocolListResponse = Type.Object({
  data: Type.Array(ProtocolSummary),
}, { $id: 'ProtocolListResponse' })

// ---------------------------------------------------------------------------
// GET /v1/oracle/protocols/:id
// ---------------------------------------------------------------------------

export const ProtocolDetailResponse = DataEnvelope(
  Type.Object({
    id: Type.String(),
    name: Type.String(),
    chains: Type.Array(Type.String()),
    status: Type.String(),
    stats: Type.Object({
      agent_count: Type.Integer(),
      wallet_count: Type.Integer(),
    }),
  }),
  'ProtocolDetailResponse',
)

// ---------------------------------------------------------------------------
// GET /v1/oracle/protocols/:id/metrics (Pro)
// ---------------------------------------------------------------------------

export const ProtocolMetricsResponse = DataEnvelope(
  Type.Object({
    protocol_id: Type.String(),
    agents: Type.Object({
      total: Type.Integer(),
      by_link_type: Type.Record(Type.String(), Type.Integer()),
    }),
    wallets: Type.Object({
      total: Type.Integer(),
      by_chain: Type.Record(Type.String(), Type.Integer()),
    }),
    evidence: Type.Object({
      total: Type.Integer(),
      by_type: Type.Record(Type.String(), Type.Integer()),
    }),
    recent_registrations_7d: Type.Integer(),
    active_conflicts: Type.Integer(),
  }),
  'ProtocolMetricsResponse',
)
```

- [ ] **Step 2: Verify it compiles**

Run: `cd C:\lucid-agent-oracle && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/schemas/protocols.ts
git commit -m "feat(oracle-api): add TypeBox schemas for all 3 protocol endpoints"
```

---

## Chunk 3: Route Rebuild + Service Changes + Wiring

### Task 10: AgentQueryService cursor support

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Modify: `apps/api/src/__tests__/agent-query.test.ts`

This task modifies `search()`, `leaderboard()`, and `getActivity()` to support cursor-based pagination. The public interfaces `SearchParams` and `LeaderboardParams` are kept for now (routes will pass decoded cursor data into them). The key changes:

1. Methods accept optional `cursorValue` + `cursorId` instead of `offset`
2. Methods return `{ data, has_more, last_sort_value, last_id }` instead of `{ agents, total }`
3. Leaderboard uses CTE for aggregate keyset pagination
4. Activity uses timestamp-only cursor

- [ ] **Step 1: Add cursor tests to agent-query.test.ts**

Add these tests to the existing test file, within the existing `describe` blocks:

In `describe('search')`:
```typescript
it('applies keyset WHERE when cursor values are provided', async () => {
  // Data query returns 2 results (limit=1 + 1 for has_more detection)
  db.query.mockResolvedValueOnce({ rows: [
    { id: 'ae_2', display_name: 'B', erc8004_id: null, created_at: '2026-03-11' },
    { id: 'ae_3', display_name: 'C', erc8004_id: null, created_at: '2026-03-10' },
  ] })
  const result = await service.search({
    wallet: '0xABC', limit: 1, offset: 0,
    cursorValue: '2026-03-12', cursorId: 'ae_1',
  })
  expect(result.data).toHaveLength(1) // trimmed to limit
  expect(result.has_more).toBe(true)
  // Verify keyset WHERE was used
  expect(db.query.mock.calls[0][0]).toContain('ae.created_at')
  expect(db.query.mock.calls[0][0]).toContain('ae.id')
})
```

In `describe('leaderboard')`:
```typescript
it('uses CTE with keyset pagination when cursor provided', async () => {
  db.query.mockResolvedValueOnce({ rows: [
    { id: 'ae_2', display_name: 'Second', erc8004_id: null, created_at: '2026-03-11', wallet_count: 3, protocol_count: 2, evidence_count: 5 },
  ] })
  const result = await service.leaderboard({
    sort: 'wallet_count', limit: 10, offset: 0,
    cursorValue: 5, cursorId: 'ae_1',
  })
  expect(result.data).toHaveLength(1)
  expect(result.has_more).toBe(false)
  // Verify CTE was used
  expect(db.query.mock.calls[0][0]).toContain('WITH ranked AS')
})
```

In `describe('getActivity')`:
```typescript
it('applies timestamp cursor when provided', async () => {
  db.query.mockResolvedValueOnce({ rows: [
    { type: 'wallet_linked', timestamp: '2026-03-10T00:00:00Z', detail: {} },
  ] })
  const result = await service.getActivity('ae_1', {
    limit: 20, offset: 0,
    cursorTimestamp: '2026-03-11T00:00:00Z',
  })
  expect(result.data).toHaveLength(1)
  expect(result.has_more).toBe(false)
  expect(db.query.mock.calls[0][0]).toContain('timestamp <')
})
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/agent-query.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: New tests FAIL (property `cursorValue` not in type, `data` not on return type).

- [ ] **Step 3: Modify search() for cursor support**

In `agent-query.ts`, update the `search()` method:

1. Add `cursorValue?: string` and `cursorId?: string` to `SearchParams`
2. If cursor values present, add keyset WHERE: `AND (ae.created_at, ae.id) < ($N, $N+1)`
3. Remove the COUNT query when cursor is present (we use LIMIT + 1 for `has_more`)
4. Fetch `limit + 1` rows, check if extra row exists → `has_more = true`, trim to `limit`
5. Return `{ data: AgentSearchResult[], has_more, last_sort_value?, last_id? }` alongside legacy `{ agents, total }`

**Implementation approach:** To preserve backward compatibility for existing tests while adding cursor support, add the cursor fields as optional to `SearchParams`. When `cursorValue` is set, skip the count query and use keyset WHERE. The method returns `{ data, has_more, last_sort_value, last_id }` (new) AND keeps `{ agents, total }` (legacy, deprecated — existing tests use these).

Actually, simpler: just change the return type. Update existing tests to use new return shape. The routes will be rewritten anyway.

**Key changes to `search()`:**

```typescript
// New return type
interface CursorResult<T> {
  data: T[]
  has_more: boolean
  last_sort_value?: string | number
  last_id?: string
}

async search(params: SearchParams): Promise<CursorResult<AgentSearchResult>> {
  // ... (keep existing WHERE/JOIN building)

  // Add keyset WHERE if cursor provided
  if (params.cursorValue && params.cursorId) {
    conditions.push(`(ae.created_at, ae.id) < (${nextParam()}, ${nextParam()})`)
    values.push(params.cursorValue, params.cursorId)
  }

  // Fetch limit + 1 for has_more detection
  const fetchLimit = limit + 1
  // ... (build query with fetchLimit, no OFFSET when cursor present)

  const hasMore = rows.length > limit
  const trimmed = hasMore ? rows.slice(0, limit) : rows
  const last = trimmed[trimmed.length - 1]

  return {
    data: trimmed.map(/* ... */),
    has_more: hasMore,
    last_sort_value: last ? String(last.created_at) : undefined,
    last_id: last?.id as string | undefined,
  }
}
```

- [ ] **Step 4: Modify leaderboard() for cursor support with CTE**

Add `cursorValue?: number` and `cursorId?: string` to `LeaderboardParams`. Rebuild the SQL as a CTE:

```typescript
async leaderboard(params: LeaderboardParams): Promise<CursorResult<LeaderboardEntry>> {
  const sortColumn = params.sort === 'newest' ? 'created_at' : params.sort
  const sortDir = 'DESC'
  const fetchLimit = params.limit + 1

  const cursorWhere = (params.cursorValue != null && params.cursorId)
    ? `WHERE (${sortColumn}, id) < ($1, $2)`
    : ''
  const cursorValues = (params.cursorValue != null && params.cursorId)
    ? [params.cursorValue, params.cursorId]
    : []

  const limitParam = `$${cursorValues.length + 1}`

  const sql = `
    WITH ranked AS (
      SELECT
        ae.id, ae.display_name, ae.erc8004_id, ae.created_at,
        COUNT(DISTINCT wm.id)::int AS wallet_count,
        COUNT(DISTINCT il.id)::int AS protocol_count,
        COUNT(DISTINCT ie.id)::int AS evidence_count
      FROM agent_entities ae
      LEFT JOIN wallet_mappings wm ON wm.agent_entity = ae.id AND wm.removed_at IS NULL
      LEFT JOIN identity_links il ON il.agent_entity = ae.id
      LEFT JOIN identity_evidence ie ON ie.agent_entity = ae.id AND ie.revoked_at IS NULL
      GROUP BY ae.id, ae.display_name, ae.erc8004_id, ae.created_at
    )
    SELECT * FROM ranked
    ${cursorWhere}
    ORDER BY ${sortColumn} ${sortDir}, id DESC
    LIMIT ${limitParam}
  `

  const { rows } = await this.db.query(sql, [...cursorValues, fetchLimit])
  // ... trim, detect has_more, return CursorResult
}
```

- [ ] **Step 5: Modify getActivity() for cursor support**

Add `cursorTimestamp?: string` to the params. Insert `WHERE timestamp < $N` into each UNION ALL branch when cursor is present:

```typescript
async getActivity(
  id: string,
  params: { limit: number; offset: number; cursorTimestamp?: string },
): Promise<CursorResult<ActivityEvent>> {
  const fetchLimit = params.limit + 1
  const cursorFilter = params.cursorTimestamp
    ? `AND verified_at < $2` // (adjust per branch: verified_at, created_at)
    : ''
  // ... build UNION query with cursor filter in each branch
  // ... use $2 for cursor timestamp, $3 for limit
}
```

- [ ] **Step 6: Update existing agent-query.test.ts assertions**

The existing tests use `result.agents` and `result.total`. Update them to use `result.data` and remove `total` checks. Add `has_more` checks where appropriate.

- [ ] **Step 7: Run all tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/agent-query.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: All tests PASS (old + new).

- [ ] **Step 8: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/services/agent-query.ts apps/api/src/__tests__/agent-query.test.ts
git commit -m "feat(oracle-api): add cursor-based pagination to search, leaderboard (CTE), and activity"
```

---

### Task 11: Rewrite routes/agents.ts + update tests

**Files:**
- Rewrite: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/__tests__/agent-routes.test.ts`

This is the most complex task. Full rewrite of all 5 agent route handlers with:
- TypeBox schema objects on each route (params, querystring, response)
- Plugin config (cache, rateLimit) per route
- Auth via `request.tenant` (from auth plugin)
- Tier gating via `requireTier('pro')` preHandler
- Cursor pagination on search, leaderboard, activity
- RFC 9457 Problem Details errors
- `{ data }` / `{ data, pagination }` response envelopes

- [ ] **Step 1: Update agent-routes.test.ts for new behavior**

The test file needs to:
1. Register a mock auth plugin that decorates `request.tenant`
2. Update response assertions to new shapes (`{ data }` instead of `{ agent }`)
3. Use `x-api-key` header + mock DB for pro tier instead of `x-api-tier` header
4. Check RFC 9457 error shapes

```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { registerAgentRoutes } from '../routes/agents.js'

// Set cursor secret for tests
process.env.CURSOR_SECRET = 'test-cursor-secret-32chars-long!'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

/** Mock auth plugin — sets request.tenant based on x-api-key header value */
const mockAuthPlugin = fp(async (app: any) => {
  app.decorateRequest('tenant', { id: null, plan: 'free' })
  app.addHook('onRequest', async (request: any) => {
    const key = request.headers['x-api-key']
    if (key === 'pro-key') {
      request.tenant = { id: 'tenant_pro', plan: 'pro' }
    } else if (key === 'growth-key') {
      request.tenant = { id: 'tenant_growth', plan: 'growth' }
    } else {
      request.tenant = { id: null, plan: 'free' }
    }
  })
})

describe('Agent routes (v2)', () => {
  const db = mockDb()
  const app = Fastify()

  beforeAll(async () => {
    await app.register(mockAuthPlugin)
    registerAgentRoutes(app, db)
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { db.query.mockReset().mockResolvedValue({ rows: [] }) })

  // --- search ---
  it('search returns 400 when no params given (RFC 9457)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search' })
    expect(res.statusCode).toBe(400)
    expect(res.json().type).toContain('missing-search-criteria')
  })

  it('search returns paginated results for wallet param', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'ae_1', display_name: 'A', erc8004_id: null, created_at: '2026-03-12' },
    ] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search?wallet=0xABC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toBeDefined()
    expect(body.pagination.has_more).toBe(false)
  })

  // --- leaderboard ---
  it('leaderboard returns paginated ranked agents', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'ae_1', display_name: 'Top', erc8004_id: null, created_at: '2026-03-12', wallet_count: 5, protocol_count: 3, evidence_count: 10 },
    ] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/leaderboard' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.pagination).toBeDefined()
  })

  // --- profile ---
  it('profile returns 404 with Problem Details for unknown agent', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_nonexistent' })
    expect(res.statusCode).toBe(404)
    expect(res.json().type).toContain('not-found')
    expect(res.json().status).toBe(404)
  })

  it('profile returns agent data in { data } envelope', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', display_name: 'Agent', erc8004_id: null, lucid_tenant: null, reputation_json: null, reputation_updated_at: null, created_at: '2026-03-12', updated_at: '2026-03-12' }] })
    db.query.mockResolvedValueOnce({ rows: [] }) // wallets
    db.query.mockResolvedValueOnce({ rows: [] }) // links
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] }) // evidence
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toBeDefined()
    expect(body.data.id).toBe('ae_1')
  })

  // --- metrics (Pro) ---
  it('metrics returns 403 for free tier (Problem Details)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1/metrics' })
    expect(res.statusCode).toBe(403)
    expect(res.json().type).toContain('tier-required')
  })

  it('metrics returns data for pro tier', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', created_at: '2026-03-12', updated_at: '2026-03-12' }] })
    for (let i = 0; i < 9; i++) {
      db.query.mockResolvedValueOnce({ rows: i === 5 ? [{ protocol: 'lucid' }] : [{ cnt: 0 }] })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/ae_1/metrics',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.wallets).toBeDefined()
  })

  // --- activity (Pro) ---
  it('activity returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1/activity' })
    expect(res.statusCode).toBe(403)
  })

  it('activity returns 404 for unknown agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/ae_nonexistent/activity',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(404)
  })

  // --- param validation ---
  it('rejects invalid agent ID format', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/INVALID' })
    expect(res.statusCode).toBe(400)
  })
})
```

- [ ] **Step 2: Run tests to see them fail against old route**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/agent-routes.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: Several failures due to new assertions vs old implementation.

- [ ] **Step 3: Rewrite routes/agents.ts**

Full rewrite. Key structure:

```typescript
import type { FastifyInstance } from 'fastify'
import type { DbClient } from '@lucid/oracle-core'
import { AgentQueryService } from '../services/agent-query.js'
import { requireTier } from '../plugins/auth.js'
import { sendProblem, AgentIdParams } from '../schemas/common.js'
import {
  AgentProfileResponse, AgentSearchQuery, AgentSearchResponse,
  LeaderboardQuery, LeaderboardResponse,
  AgentMetricsResponse, ActivityQuery, ActivityResponse,
} from '../schemas/agents.js'
import { encodeCursor, decodeCursor } from '../utils/cursor.js'
import { keys } from '../services/redis.js'

export function registerAgentRoutes(app: FastifyInstance, db: DbClient): void {
  const service = new AgentQueryService(db)

  // --- search (must be before :id) ---
  app.get('/v1/oracle/agents/search', {
    schema: {
      tags: ['agents'],
      summary: 'Search agents',
      querystring: AgentSearchQuery,
      response: { 200: AgentSearchResponse, 400: { $ref: 'ProblemDetail' } },
    },
    config: {
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { wallet, chain, protocol, protocol_id, erc8004_id, q, limit: rawLimit, cursor } = request.query as any
    if (!wallet && !protocol && !protocol_id && !erc8004_id && !q) {
      return sendProblem(reply, 400, {
        type: 'missing-search-criteria',
        title: 'Missing search criteria',
        detail: 'At least one search parameter required (wallet, protocol, protocol_id, erc8004_id, q).',
        instance: request.url,
      })
    }

    const limit = rawLimit ?? 20
    const decoded = cursor ? decodeCursor(cursor) : null

    const result = await service.search({
      wallet, chain, protocol, protocol_id, erc8004_id, q,
      limit,
      offset: 0, // offset unused when cursor present
      cursorValue: decoded?.s as string | undefined,
      cursorId: decoded?.id,
    })

    const nextCursor = result.has_more && result.last_sort_value && result.last_id
      ? encodeCursor(result.last_sort_value, result.last_id)
      : null

    return reply.send({
      data: result.data,
      pagination: { next_cursor: nextCursor, has_more: result.has_more, limit },
    })
  })

  // --- leaderboard (must be before :id) ---
  app.get('/v1/oracle/agents/leaderboard', {
    schema: {
      tags: ['agents'],
      summary: 'Agent leaderboard',
      querystring: LeaderboardQuery,
      response: { 200: LeaderboardResponse },
    },
    config: {
      cache: { ttl: 60, key: (req: any) => {
        // Version is read synchronously from a module-level var that's updated by cache invalidation.
        // See: getLeaderboardVersion() in services/redis.ts
        const q = req.query as any
        const version = (globalThis as any).__lbVersion ?? 0
        return keys.leaderboard(version, q.sort ?? 'wallet_count', q.cursor ?? 'first', req.tenant?.plan ?? 'free')
      }},
      rateLimit: { max: 60 },
    },
  }, async (request, reply) => {
    const { sort: rawSort, limit: rawLimit, cursor } = request.query as any
    const sort = rawSort ?? 'wallet_count'
    const limit = rawLimit ?? 20
    const decoded = cursor ? decodeCursor(cursor) : null

    const result = await service.leaderboard({
      sort, limit, offset: 0,
      cursorValue: decoded?.s as number | undefined,
      cursorId: decoded?.id,
    })

    const nextCursor = result.has_more && result.last_sort_value != null && result.last_id
      ? encodeCursor(result.last_sort_value, result.last_id)
      : null

    return reply.send({
      data: result.data,
      pagination: { next_cursor: nextCursor, has_more: result.has_more, limit },
    })
  })

  // --- profile ---
  app.get('/v1/oracle/agents/:id', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent profile',
      params: AgentIdParams,
      response: { 200: AgentProfileResponse, 404: { $ref: 'ProblemDetail' } },
    },
    config: {
      cache: { ttl: 30, key: (req: any) => keys.agentProfile(req.params.id) },
      rateLimit: { max: 60 },
    },
  }, async (request, reply) => {
    const { id } = request.params as any
    const profile = await service.getProfile(id)
    if (!profile) {
      return sendProblem(reply, 404, {
        type: 'not-found',
        title: 'Agent not found',
        instance: request.url,
      })
    }

    // Map service layer shape to API response shape
    return reply.send({
      data: {
        id: profile.id,
        display_name: profile.display_name,
        erc8004_id: profile.erc8004_id,
        lucid_tenant: profile.lucid_tenant,
        reputation: profile.reputation_json
          ? { score: (profile.reputation_json as any).score, updated_at: profile.reputation_updated_at }
          : null,
        wallets: profile.wallets,
        protocols: profile.identity_links,
        stats: {
          wallet_count: profile.wallets.length,
          protocol_count: profile.identity_links.length,
          evidence_count: profile.evidence_count,
        },
        created_at: profile.created_at,
        updated_at: profile.updated_at,
      },
    })
  })

  // --- metrics (Pro) ---
  app.get('/v1/oracle/agents/:id/metrics', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent metrics',
      description: 'Detailed per-agent statistics. Requires Pro tier.',
      params: AgentIdParams,
      response: { 200: AgentMetricsResponse, 403: { $ref: 'ProblemDetail' }, 404: { $ref: 'ProblemDetail' } },
      security: [{ apiKey: [] }],
    },
    preHandler: [requireTier('pro')],
    config: {
      cache: { ttl: 60, key: (req: any) => keys.agentMetrics(req.params.id, req.tenant?.plan ?? 'free') },
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { id } = request.params as any
    const metrics = await service.getMetrics(id)
    if (!metrics) {
      return sendProblem(reply, 404, { type: 'not-found', title: 'Agent not found', instance: request.url })
    }
    return reply.send({
      data: {
        agent_id: metrics.id,
        wallets: metrics.wallets,
        evidence: metrics.evidence,
        protocols: metrics.protocols,
        conflicts: metrics.conflicts,
        first_seen: metrics.first_seen,
        last_active: metrics.last_active,
      },
    })
  })

  // --- activity (Pro) ---
  app.get('/v1/oracle/agents/:id/activity', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent activity',
      description: 'Recent identity events. Requires Pro tier.',
      params: AgentIdParams,
      querystring: ActivityQuery,
      response: { 200: ActivityResponse, 403: { $ref: 'ProblemDetail' }, 404: { $ref: 'ProblemDetail' } },
      security: [{ apiKey: [] }],
    },
    preHandler: [requireTier('pro')],
    config: {
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { id } = request.params as any
    const { limit: rawLimit, cursor } = request.query as any
    const limit = rawLimit ?? 20

    const exists = await service.exists(id)
    if (!exists) {
      return sendProblem(reply, 404, { type: 'not-found', title: 'Agent not found', instance: request.url })
    }

    const decoded = cursor ? decodeCursor(cursor) : null
    const result = await service.getActivity(id, {
      limit, offset: 0,
      cursorTimestamp: decoded?.s as string | undefined,
    })

    const nextCursor = result.has_more && result.last_sort_value
      ? encodeCursor(result.last_sort_value, 'ts') // activity uses timestamp-only cursor
      : null

    return reply.send({
      data: result.data,
      pagination: { next_cursor: nextCursor, has_more: result.has_more, limit },
    })
  })
}
```

**IMPORTANT implementation notes:**
- Route registration order matters: `search` and `leaderboard` MUST be registered before `:id` to avoid path matching conflicts
- The `config.rateLimit` shape must match `@fastify/rate-limit`'s per-route config API — verify against docs
- For leaderboard cache, use versioned namespace key. In production, read `oracle:lb:version` from Redis. In MVP, use 0 as version.
- The `as any` casts on `request.params` and `request.query` should be replaced with proper TypeBox-inferred types once the TypeBox type provider is wired in server.ts. For the route file itself, the types flow from the `schema` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/agent-routes.test.ts --reporter=verbose 2>&1 | tail -25`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/routes/agents.ts apps/api/src/__tests__/agent-routes.test.ts
git commit -m "feat(oracle-api): rewrite agent routes — TypeBox schemas, cursor pagination, RFC 9457 errors"
```

---

### Task 12: Rewrite routes/protocols.ts + update tests

**Files:**
- Rewrite: `apps/api/src/routes/protocols.ts`
- Modify: `apps/api/src/__tests__/protocol-routes.test.ts`

Protocols.ts grows from 2 to 3 endpoints (add protocol list, migrated from v1.ts).

- [ ] **Step 1: Update protocol-routes.test.ts**

```typescript
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { registerProtocolRoutes } from '../routes/protocols.js'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

const mockAuthPlugin = fp(async (app: any) => {
  app.decorateRequest('tenant', { id: null, plan: 'free' })
  app.addHook('onRequest', async (request: any) => {
    const key = request.headers['x-api-key']
    if (key === 'pro-key') {
      request.tenant = { id: 'tenant_pro', plan: 'pro' }
    } else {
      request.tenant = { id: null, plan: 'free' }
    }
  })
})

describe('Protocol routes (v2)', () => {
  const db = mockDb()
  const app = Fastify()

  beforeAll(async () => {
    await app.register(mockAuthPlugin)
    registerProtocolRoutes(app, db)
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { db.query.mockReset().mockResolvedValue({ rows: [] }) })

  // --- list ---
  it('GET /protocols returns all protocols in { data } envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.length).toBeGreaterThanOrEqual(4)
    expect(body.data.find((p: any) => p.id === 'lucid')).toBeTruthy()
  })

  // --- detail ---
  it('returns 404 for unknown protocol (Problem Details)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols/unknown' })
    expect(res.statusCode).toBe(404)
    expect(res.json().type).toContain('not-found')
  })

  it('returns protocol detail with stats in { data } envelope', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 42 }] })
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 85 }] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols/lucid' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.name).toBe('Lucid')
    expect(body.data.stats.agent_count).toBe(42)
  })

  // --- metrics (Pro) ---
  it('metrics returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols/lucid/metrics' })
    expect(res.statusCode).toBe(403)
    expect(res.json().type).toContain('tier-required')
  })

  it('metrics returns data for pro tier in { data } envelope', async () => {
    for (let i = 0; i < 8; i++) {
      db.query.mockResolvedValueOnce({ rows: [{ cnt: i + 1 }] })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/protocols/lucid/metrics',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.agents).toBeDefined()
  })

  it('metrics returns 404 for unknown protocol', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/protocols/unknown/metrics',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: Run tests to see failures**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/protocol-routes.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: Failures due to new assertions.

- [ ] **Step 3: Rewrite routes/protocols.ts**

```typescript
import type { FastifyInstance } from 'fastify'
import type { DbClient } from '@lucid/oracle-core'
import { AgentQueryService, PROTOCOL_REGISTRY } from '../services/agent-query.js'
import { requireTier } from '../plugins/auth.js'
import { sendProblem, ProtocolIdParams } from '../schemas/common.js'
import { ProtocolListResponse, ProtocolDetailResponse, ProtocolMetricsResponse } from '../schemas/protocols.js'
import { keys } from '../services/redis.js'

export function registerProtocolRoutes(app: FastifyInstance, db: DbClient): void {
  const service = new AgentQueryService(db)

  // --- list ---
  app.get('/v1/oracle/protocols', {
    schema: {
      tags: ['protocols'],
      summary: 'List all protocols',
      response: { 200: ProtocolListResponse },
    },
    config: {
      cache: { ttl: 120, key: () => keys.protocolList() },
      rateLimit: { max: 60 },
    },
  }, async (_request, reply) => {
    return reply.send({
      data: Object.entries(PROTOCOL_REGISTRY).map(([id, meta]) => ({
        id,
        ...meta,
      })),
    })
  })

  // --- detail ---
  app.get('/v1/oracle/protocols/:id', {
    schema: {
      tags: ['protocols'],
      summary: 'Get protocol detail',
      params: ProtocolIdParams,
      response: { 200: ProtocolDetailResponse, 404: { $ref: 'ProblemDetail' } },
    },
    config: {
      cache: { ttl: 60, key: (req: any) => keys.protocolDetail(req.params.id) },
      rateLimit: { max: 60 },
    },
  }, async (request, reply) => {
    const { id } = request.params as any
    const protocol = await service.getProtocol(id)
    if (!protocol) {
      return sendProblem(reply, 404, { type: 'not-found', title: 'Protocol not found', instance: request.url })
    }
    return reply.send({
      data: {
        id: protocol.id,
        name: protocol.name,
        chains: protocol.chains,
        status: protocol.status,
        stats: {
          agent_count: protocol.agent_count,
          wallet_count: protocol.wallet_count,
        },
      },
    })
  })

  // --- metrics (Pro) ---
  app.get('/v1/oracle/protocols/:id/metrics', {
    schema: {
      tags: ['protocols'],
      summary: 'Get protocol metrics',
      description: 'Deep protocol metrics. Requires Pro tier.',
      params: ProtocolIdParams,
      response: { 200: ProtocolMetricsResponse, 403: { $ref: 'ProblemDetail' }, 404: { $ref: 'ProblemDetail' } },
      security: [{ apiKey: [] }],
    },
    preHandler: [requireTier('pro')],
    config: {
      cache: { ttl: 60, key: (req: any) => keys.protocolMetrics(req.params.id, req.tenant?.plan ?? 'free') },
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { id } = request.params as any
    const metrics = await service.getProtocolMetrics(id)
    if (!metrics) {
      return sendProblem(reply, 404, { type: 'not-found', title: 'Protocol not found', instance: request.url })
    }
    return reply.send({
      data: {
        protocol_id: metrics.id,
        agents: metrics.agents,
        wallets: metrics.wallets,
        evidence: metrics.evidence,
        recent_registrations_7d: metrics.recent_registrations_7d,
        active_conflicts: metrics.active_conflicts,
      },
    })
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/protocol-routes.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/routes/protocols.ts apps/api/src/__tests__/protocol-routes.test.ts
git commit -m "feat(oracle-api): rewrite protocol routes — 3 endpoints, TypeBox schemas, migrate protocol list from v1.ts"
```

---

### Task 13: Update v1.ts — RFC 9457 errors + remove protocol list

**Files:**
- Modify: `apps/api/src/routes/v1.ts`
- Modify: `apps/api/src/__tests__/api.test.ts`

- [ ] **Step 1: Update api.test.ts for RFC 9457 errors**

Update the 404 test and protocol list test:

```typescript
// Change this test to expect RFC 9457 error shape:
it('GET /v1/oracle/feeds/nonexistent returns 404 (Problem Details)', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/nonexistent' })
  expect(res.statusCode).toBe(404)
  const body = res.json()
  expect(body.type).toContain('not-found')
  expect(body.status).toBe(404)
})

// Remove or update the protocol list test — protocols are now in protocols.ts
// This test should verify the endpoint is gone from v1.ts:
it('GET /v1/oracle/protocols is no longer registered on v1 routes', async () => {
  // The protocol list now lives in protocols.ts, not v1.ts.
  // If only v1 routes are registered (as in this test), /protocols returns 404.
  const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols' })
  expect(res.statusCode).toBe(404)
})
```

- [ ] **Step 2: Update v1.ts**

1. Remove the `GET /v1/oracle/protocols` handler (moved to protocols.ts)
2. Replace all `reply.status(404).send({ error: '...' })` with `sendProblem(reply, 404, { ... })`
3. Import `sendProblem` from `../schemas/common.js`
4. Remove the `PROTOCOL_REGISTRY` import (no longer needed in v1.ts since protocol list moved)

Changes to v1.ts:
- Remove lines 172-180 (protocol list endpoint)
- Update lines 91-93 (feed 404): use `sendProblem`
- Update lines 107-109 (methodology 404): use `sendProblem`

- [ ] **Step 3: Run tests**

Run: `cd C:\lucid-agent-oracle && npx vitest run apps/api/src/__tests__/api.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/routes/v1.ts apps/api/src/__tests__/api.test.ts
git commit -m "feat(oracle-api): standardize v1.ts errors to RFC 9457, remove protocol list (moved to protocols.ts)"
```

---

### Task 14: Wire server.ts — TypeBox, Swagger, plugins, Redis, CORS, shutdown

**Files:**
- Modify: `apps/api/src/server.ts`

This is the integration task. Wire everything together.

- [ ] **Step 1: Update server.ts**

Key changes to `apps/api/src/server.ts`:

1. **Import TypeBox type provider** and apply via `.withTypeProvider<TypeBoxTypeProvider>()`
2. **Register Swagger** (BEFORE any routes)
3. **Register shared schemas** via `app.addSchema()`
4. **Init Redis** from `REDIS_URL` env
5. **Fail-fast** on missing `CURSOR_SECRET` (when DATABASE_URL is set)
6. **Register plugins** in order: auth → rate-limit → cache
7. **Update CORS** exposedHeaders
8. **Add Redis shutdown** to graceful shutdown handler

```typescript
// At top of file, add imports:
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { initRedis, closeRedis, getRedis } from './services/redis.js'
import { authPlugin } from './plugins/auth.js'
import { cachePlugin } from './plugins/cache.js'
import { rateLimitPlugin } from './plugins/rate-limit.js'
import { ProblemDetail, CursorQuery, CursorMeta, AgentIdParams, ProtocolIdParams, registerGlobalErrorHandler } from './schemas/common.js'
import { assertCursorSecret } from './utils/cursor.js'
import { loadLeaderboardVersion } from './services/redis.js'

// Change Fastify init:
const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>()

// Register Swagger BEFORE routes:
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
await app.register(swaggerUi, { routePrefix: '/docs' })

// Register shared schemas for $ref reuse
app.addSchema(ProblemDetail)
app.addSchema(CursorQuery)
app.addSchema(CursorMeta)
app.addSchema(AgentIdParams)
app.addSchema(ProtocolIdParams)

// Global error handler — ensures ALL errors are RFC 9457 Problem Details
// (Ajv validation 400s, rate-limit 429s, unhandled exceptions)
registerGlobalErrorHandler(app)

// Update CORS:
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

// In the DATABASE_URL block, before registering routes:
// Fail-fast on CURSOR_SECRET
if (process.env.DATABASE_URL) {
  assertCursorSecret()
}

// Register plugins (ORDER MATTERS: auth -> rate-limit -> cache)
await app.register(authPlugin, { db: client, redis })
await app.register(rateLimitPlugin, { redis })
await app.register(cachePlugin, { redis })

// In graceful shutdown handler, add:
await closeRedis()
```

**IMPORTANT:** The auth plugin needs `db` (the pg client). It must be registered inside the `if (databaseUrl)` block where `client` is available. If `DATABASE_URL` is not set, register a no-op auth plugin or skip auth registration (all requests get `{ id: null, plan: 'free' }`).

The exact integration requires reading the current server.ts structure carefully. The auth/cache/rate-limit plugins should wrap the agent + protocol routes, not the health endpoint.

- [ ] **Step 2: Run all tests**

Run: `cd C:\lucid-agent-oracle && npx vitest run --reporter=verbose 2>&1 | tail -30`
Expected: All tests PASS.

- [ ] **Step 3: Verify OpenAPI endpoint works (manual)**

If the API can be started locally:
Run: `cd C:\lucid-agent-oracle && CURSOR_SECRET=dev-secret timeout 5 node --loader tsx apps/api/src/server.ts 2>&1 | head -20`

Then check: `curl http://localhost:4040/docs` returns Swagger UI HTML.

If the API can't start (needs DATABASE_URL, etc.), skip this — it will be verified in production deployment.

- [ ] **Step 4: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/server.ts
git commit -m "feat(oracle-api): wire TypeBox type provider, Swagger, Redis, auth/cache/rate-limit plugins"
```

---

### Task 15: Wire cache invalidation into write paths

**Files:**
- Modify: `apps/api/src/routes/identity-registration.ts`
- Modify: `apps/api/src/routes/identity-admin.ts`
- Modify: `apps/api/src/services/lucid-resolver.ts`

Cache invalidation must be triggered on write events per the spec (Section 4.2):
- **Registration success** → `invalidateAgentCaches(agentId)`
- **Conflict resolution** → `invalidateAgentCaches(existingId, claimingId)`
- **Lucid resolver run** → `invalidateProtocolCaches()`

- [ ] **Step 1: Find registration success paths**

Search `identity-registration.ts` for the point where a new agent entity is created or a wallet is linked. This is where `invalidateAgentCaches()` should be called.

Search `identity-admin.ts` for conflict resolution endpoints (status change to 'resolved'). This is where `invalidateAgentCaches(existingId, claimingId)` should be called.

- [ ] **Step 2: Add invalidation calls**

In `identity-registration.ts`, after successful registration:
```typescript
import { invalidateAgentCaches } from '../services/redis.js'
// ... after successful entity creation or wallet linking:
await invalidateAgentCaches(agentEntityId)
```

In `identity-admin.ts`, after conflict resolution:
```typescript
import { invalidateAgentCaches } from '../services/redis.js'
// ... after conflict status update to 'resolved':
await invalidateAgentCaches(existingEntity, claimingEntity)
```

In `lucid-resolver.ts`, after resolver run completes:
```typescript
import { invalidateProtocolCaches } from '../services/redis.js'
// ... after the resolver's main processing loop:
await invalidateProtocolCaches()
```

- [ ] **Step 3: Add loadLeaderboardVersion() to server.ts startup**

In server.ts, after Redis init:
```typescript
import { loadLeaderboardVersion } from './services/redis.js'
// After initRedis:
await loadLeaderboardVersion()
```

- [ ] **Step 4: Run all tests to verify no regressions**

Run: `cd C:\lucid-agent-oracle && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: All tests pass. Invalidation calls are no-ops when Redis is null.

- [ ] **Step 5: Commit**

```bash
cd C:\lucid-agent-oracle
git add apps/api/src/routes/identity-registration.ts apps/api/src/routes/identity-admin.ts apps/api/src/services/lucid-resolver.ts apps/api/src/server.ts apps/api/src/services/redis.ts
git commit -m "feat(oracle-api): wire cache invalidation into registration, conflict resolution, and resolver write paths"
```

---

### Task 16: Final verification + cleanup

**Files:** None new. Verification only.

- [ ] **Step 1: Run full test suite**

Run: `cd C:\lucid-agent-oracle && npx vitest run --reporter=verbose 2>&1`
Expected: 50+ tests, 0 failures.

Count test files that should have tests:
- `agent-query.test.ts` — ~18 tests (15 existing + 3 cursor)
- `agent-routes.test.ts` — ~10 tests
- `protocol-routes.test.ts` — ~6 tests
- `api.test.ts` — ~8 tests
- `cursor.test.ts` — ~6 tests
- `auth-plugin.test.ts` — ~5 tests
- `cache-plugin.test.ts` — ~4 tests
- Other existing tests — ~12 tests (conflict-review, helius, lucid-resolver, registration, watchlist)
Total: ~69 tests

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd C:\lucid-agent-oracle && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors.

- [ ] **Step 3: Check for accidental leftover `x-api-tier` usage**

Run a grep to make sure no route still reads `x-api-tier`:
Search for `x-api-tier` in `apps/api/src/routes/`.
Expected: Zero matches (all tier resolution now via auth plugin).

- [ ] **Step 4: Verify all error responses use Problem Details**

Search for `{ error:` in route files — should only appear in non-route files (tests, etc.).
Expected: No `{ error: '...' }` responses in route handlers.

- [ ] **Step 5: Commit any final cleanup**

```bash
cd C:\lucid-agent-oracle
git add -A
git commit -m "chore(oracle-api): Plan 3A v2 final cleanup and verification"
```

---

## Summary

| Metric | Target | Notes |
|--------|--------|-------|
| New files | 11 | 7 source + 4 test |
| Modified files | 11 | 7 source + 4 test |
| Total tests | 50+ | ~72 expected |
| Endpoints with TypeBox schemas | 8 | 5 agent + 3 protocol |
| OpenAPI at `/docs` | Yes | Auto-generated from schemas |
| Redis-cached endpoints | 6 | profile, metrics, leaderboard, protocols list, protocol detail, protocol metrics |
| Cursor-paginated endpoints | 3 | search, leaderboard, activity |
| Rate-limited endpoints | 8 | All Plan 3A endpoints |
| RFC 9457 errors | All | Including v1.ts feeds/reports, Ajv validation, rate-limit 429s |
| Cache invalidation hooks | 3 | registration, conflict resolution, resolver run |
| Global error handler | Yes | setErrorHandler for RFC 9457 on ALL errors |
