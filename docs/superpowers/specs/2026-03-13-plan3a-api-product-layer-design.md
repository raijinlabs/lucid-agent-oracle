# Plan 3A v2: API Product Layer — Agents as First-Class Noun

**Date:** 2026-03-13
**Status:** Approved
**Authors:** RaijinLabs + Claude
**Parent spec:** `docs/specs/2026-03-12-agent-economy-oracle-design.md`
**Supersedes:** `docs/specs/2026-03-12-agent-economy-oracle-plan3a-api-expansion-design.md` (v1 — query layer only)
**Depends on:** Plan 4B (Self-Registration + Identity Evidence)
**Unlocks:** Dashboard (SS10), SDK (`@lucidai/oracle`), MCP Tools (SS9.3), SSE streaming (Plan 3B)

---

## 1. Goal

Upgrade the Oracle REST API from working handlers to a **production-grade API product surface**. Plan 3A v1 delivered the correct query/service layer. This v2 replaces the API chassis: schema validation, OpenAPI documentation, Redis caching, proper auth/tiering, cursor pagination, rate limiting, and consistent error contracts.

**Design principle:** Keep the engine, replace the chassis. The `AgentQueryService` query logic is preserved. Everything above it — route definitions, validation, serialization, caching, auth, error format — is rebuilt to industry standard.

**Strategy:** Enhance in place (approach B). Selective SQL optimization only where measurement says it's needed.

---

## 2. Architecture

### 2.1 Stack

| Layer | Technology | Role |
|-------|-----------|------|
| Type system | `@sinclair/typebox` | Single source of truth for validation, serialization, OpenAPI, and TypeScript types |
| Type provider | `@fastify/type-provider-typebox` | Infers TypeScript types from route schemas — no manual casts |
| Validation | Fastify built-in (Ajv) | Request validation from TypeBox schemas |
| Serialization | Fastify built-in (`fast-json-stringify`) | 2-3x faster response serialization from TypeBox schemas |
| OpenAPI | `@fastify/swagger` | Generates OpenAPI 3.0.0 spec from route schemas |
| Interactive docs | `@fastify/swagger-ui` | Swagger UI at `/docs` |
| Cache | `redis` (node-redis) | Hot cache for expensive read endpoints |
| Rate limiting | `@fastify/rate-limit` (evaluate) or custom wrapper | Per-route, Redis-backed, per-plan limits |

### 2.2 New Dependencies (`apps/api/package.json`)

```json
{
  "@sinclair/typebox": "^0.34.0",
  "@fastify/type-provider-typebox": "^5.0.0",
  "@fastify/swagger": "^9.0.0",
  "@fastify/swagger-ui": "^5.0.0",
  "redis": "^4.7.0"
}
```

### 2.3 Fastify Bootstrap

```typescript
import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>()

// Swagger MUST be registered before routes
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
```

### 2.4 Hook Ordering

```
onRequest:   auth plugin     (resolve x-api-key --> tenant/plan, decorate request.tenant)
onRequest:   rate-limit      (check per-route limits, even on cache hits)
preHandler:  cache plugin    (Redis GET, short-circuit on HIT)
handler:     business logic  (only on cache MISS)
onSend:      cache plugin    (Redis SET on 200 GET/HEAD only)
```

---

## 3. Shared Schemas

**File:** `apps/api/src/schemas/common.ts`

All shared schemas registered on the Fastify instance via `addSchema()` with `$id` for `$ref` reuse across routes and OpenAPI generation.

### 3.1 Error Response (RFC 9457 Problem Details)

```typescript
import { Type, Static } from '@sinclair/typebox'

export const ProblemDetail = Type.Object({
  type: Type.String({ description: 'URI reference identifying the problem type' }),
  title: Type.String({ description: 'Short human-readable summary' }),
  status: Type.Integer({ description: 'HTTP status code' }),
  detail: Type.Optional(Type.String({ description: 'Human-readable explanation' })),
  instance: Type.Optional(Type.String({ description: 'URI of the request that caused the problem' })),
  code: Type.Optional(Type.String({ description: 'Machine-readable error code' })),
}, { $id: 'ProblemDetail' })
export type ProblemDetailType = Static<typeof ProblemDetail>
```

**Error type URIs:** `https://oracle.lucid.foundation/errors/{error-type}` (e.g., `/errors/not-found`, `/errors/tier-required`, `/errors/rate-limited`).

**Applied immediately to all routes** including existing `v1.ts` feed/report routes, so the API has one error dialect.

### 3.2 Cursor Pagination

```typescript
export const CursorQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  cursor: Type.Optional(Type.String({ description: 'Opaque cursor from previous response' })),
}, { $id: 'CursorQuery' })

export const CursorMeta = Type.Object({
  next_cursor: Type.Union([Type.String(), Type.Null()]),
  has_more: Type.Boolean(),
  limit: Type.Integer(),
}, { $id: 'CursorMeta' })
```

**Cursor format:** Base64url-encoded JSON with:
- `v`: version number (starts at 1)
- `s`: sort field value
- `id`: entity ID (for deterministic tie-breaking)
- `sig`: HMAC-SHA256 signature over `v + s + id` using server-side secret

Prevents casual tampering. Version field enables migration if sort keys change.

**Cursor decoding** in the service layer translates to keyset WHERE: `WHERE (sort_field, id) < ($1, $2)`.

**Applied to:** `agents/search`, `agents/leaderboard`, `agents/:id/activity`. NOT applied to small stable lists like `/protocols`.

### 3.3 List Envelope

```typescript
// Generic paginated list response
export function PaginatedList<T extends TSchema>(itemSchema: T, $id: string) {
  return Type.Object({
    data: Type.Array(itemSchema),
    pagination: CursorMeta,
  }, { $id })
}
```

### 3.4 ID Parameters

```typescript
export const AgentIdParams = Type.Object({
  id: Type.String({
    minLength: 4,
    pattern: '^ae_',
    description: 'Agent entity ID (e.g., ae_7f3k9x2m)',
  }),
}, { $id: 'AgentIdParams' })

export const ProtocolIdParams = Type.Object({
  id: Type.String({
    minLength: 2,
    enum: ['lucid', 'virtuals', 'olas', 'erc8004'],
    description: 'Protocol identifier',
  }),
}, { $id: 'ProtocolIdParams' })
```

---

## 4. Plugins

### 4.1 Auth Plugin (`plugins/auth.ts`)

**Fastify `onRequest` hook.** Runs on every request.

1. Extract `x-api-key` from header
2. If present:
   - Look up in Redis: `oracle:apikey:{sha256(key)}` --> `{ tenant_id, plan }`
   - Cache TTL: 300s
   - Cache miss: query `gateway_tenants` table, populate Redis
   - Invalid key: return 401 Problem Details
3. If absent: `request.tenant = { id: null, plan: 'free' }`
4. Decorate `request.tenant` on every request (stable shape, always present)

**Tier gate helper:**

```typescript
export function requireTier(minTier: 'pro' | 'growth') {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const plan = request.tenant.plan
    if (tierRank(plan) < tierRank(minTier)) {
      return reply.status(403).send({
        type: 'https://oracle.lucid.foundation/errors/tier-required',
        title: 'Insufficient tier',
        status: 403,
        detail: `This endpoint requires ${minTier} tier or above`,
        instance: request.url,
      })
    }
  }
}

function tierRank(plan: string): number {
  return { free: 0, pro: 1, growth: 2 }[plan] ?? 0
}
```

Routes use: `preHandler: [requireTier('pro')]`

### 4.2 Cache Plugin (`plugins/cache.ts`)

**Route-level configuration via `config.cache`:**

```typescript
config: {
  cache: {
    ttl: 60,
    key: (req: FastifyRequest) => `oracle:agent:profile:${req.params.id}`,
  },
}
```

**Behavior:**
- `preHandler`: check Redis. HIT --> send cached response, add `X-Cache: HIT` header
- `onSend`: on cache MISS, store response in Redis with TTL, add `X-Cache: MISS` header
- **Only cache 200 GET/HEAD responses.** Never cache 4xx/5xx.
- Cache key MUST include plan where response differs by tier
- Identity/admin routes explicitly exempt (no `config.cache`)

**Cache invalidation (narrow, explicit):**
- Registration success --> `del(agent:profile:{id})`, increment `oracle:lb:version`
- Conflict resolution --> `del(agent:profile:{existing})`, `del(agent:profile:{claiming})`, increment `oracle:lb:version`
- Lucid resolver run --> `del(oracle:protocols)`, `del(oracle:protocol:*)` (bounded set)
- No dependency graph. No pub/sub. Direct `del()` calls in existing write paths.

**Leaderboard versioned namespace:**
- Key format: `oracle:lb:v{N}:{sort}:{cursor}:{plan}`
- `oracle:lb:version` is an integer counter in Redis
- On write events, `INCR oracle:lb:version` -- new reads naturally miss stale keys
- Old versioned keys expire via TTL (60s), no scan/delete needed

### 4.3 Rate Limit Plugin (`plugins/rate-limit.ts`)

**Evaluate `@fastify/rate-limit`** as the primary implementation. If it meets all requirements, use it directly. If not, wrap the existing `RateLimiter` class.

**Requirements:**
- Redis-backed counters (consistent across instances)
- Per-route configuration
- Per-plan limits (higher limits for Pro/Growth)
- `Retry-After` header on 429
- RFC 9457 Problem Details response body
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers

**Per-route config:**

```typescript
config: {
  rateLimit: {
    window: 60_000,
    max: { free: 30, pro: 300, growth: 1000 },
    key: (req: FastifyRequest) => req.tenant.id ?? req.ip,
  },
}
```

**Graceful degradation:** If Redis is unavailable, fall back to in-memory `RateLimiter`. This is per-instance (not globally consistent across horizontally scaled API processes), which is acceptable as a degradation path. Document this tradeoff.

---

## 5. Route Rebuild

### 5.1 File Structure

```
apps/api/src/
+-- schemas/
|   +-- common.ts           <-- RFC 9457 errors, cursor, list envelope, ID params
|   +-- agents.ts           <-- Agent profile, search, leaderboard, metrics, activity schemas
|   +-- protocols.ts        <-- Protocol detail, list, metrics schemas
+-- plugins/
|   +-- auth.ts             <-- API key --> tenant/plan resolution
|   +-- cache.ts            <-- Redis response cache (preHandler/onSend)
|   +-- rate-limit.ts       <-- Per-route rate limiting
+-- services/
|   +-- redis.ts            <-- NEW: Redis client singleton + key builders
|   +-- agent-query.ts      <-- KEPT: add cursor support to search/leaderboard/activity
|   +-- rate-limiter.ts     <-- KEPT: in-memory fallback
|   +-- (other existing)
+-- routes/
|   +-- agents.ts           <-- REWRITTEN: TypeBox schemas, plugin config, thin handlers
|   +-- protocols.ts        <-- REWRITTEN: all 3 endpoints, TypeBox schemas
|   +-- v1.ts               <-- UPDATED: Problem Details errors only (full schema upgrade deferred)
|   +-- identity-registration.ts  <-- KEPT: exempt from response caching
|   +-- identity-admin.ts        <-- KEPT: exempt from response caching
```

### 5.2 Endpoints

#### Agent Endpoints

| Method | Endpoint | Tier | Cache | Pagination | Rate Limit |
|--------|----------|------|-------|------------|------------|
| GET | `/v1/oracle/agents/:id` | Free | 30s | No | 60/min |
| GET | `/v1/oracle/agents/:id/metrics` | Pro | 60s | No | 30/min |
| GET | `/v1/oracle/agents/:id/activity` | Pro | No | Cursor | 30/min |
| GET | `/v1/oracle/agents/search` | Free | No | Cursor | 30/min |
| GET | `/v1/oracle/agents/leaderboard` | Free | 60s (versioned) | Cursor | 60/min |

#### Protocol Endpoints

| Method | Endpoint | Tier | Cache | Pagination | Rate Limit |
|--------|----------|------|-------|------------|------------|
| GET | `/v1/oracle/protocols` | Free | 120s | No (small stable list) | 60/min |
| GET | `/v1/oracle/protocols/:id` | Free | 60s | No | 60/min |
| GET | `/v1/oracle/protocols/:id/metrics` | Pro | 60s | No | 30/min |

### 5.3 Example Route Definition

```typescript
app.get('/v1/oracle/agents/:id', {
  schema: {
    tags: ['agents'],
    summary: 'Get agent profile',
    description: 'Returns full agent identity: wallets, protocols, evidence summary, reputation.',
    params: AgentIdParams,
    response: {
      200: AgentProfileResponse,
      404: { $ref: 'ProblemDetail' },
    },
    security: [{ apiKey: [] }],
  },
  config: {
    cache: { ttl: 30, key: (req) => keys.agentProfile(req.params.id) },
    rateLimit: { window: 60_000, max: { free: 60, pro: 600, growth: 3000 }, key: (req) => req.tenant.id ?? req.ip },
  },
}, async (request, reply) => {
  const agent = await service.getProfile(request.params.id)
  if (!agent) {
    return reply.status(404).send({
      type: 'https://oracle.lucid.foundation/errors/not-found',
      title: 'Agent not found',
      status: 404,
      instance: request.url,
    })
  }
  return reply.send({ data: agent })
})
```

### 5.4 Service Layer Changes (Minimal)

The `AgentQueryService` methods stay. Changes:

1. **Add cursor support** to `search()`, `leaderboard()`, `getActivity()`:
   - Accept decoded cursor object (sort value + entity ID)
   - Build keyset WHERE clause: `WHERE (sort_field, id) < ($1, $2)`
   - Return next cursor (encode from last row)
2. **Remove** `SearchParams`, `LeaderboardParams` interfaces (TypeBox schemas replace them)
3. **`exists()` stays** for activity endpoint
4. **No changes** to `getProfile()`, `getMetrics()`, `getProtocol()`, `getProtocolMetrics()`

### 5.5 What Gets Deleted from Routes

- All `as { id: string }` casts (TypeBox type provider infers)
- All inline `x-api-tier` checks (auth plugin resolves tier from API key)
- All manual `parseInt(query.limit)` parsing (TypeBox validates + coerces)
- All `{ error: "..." }` responses (replaced by RFC 9457 Problem Details)

---

## 6. Redis Integration

### 6.1 Redis Client (`services/redis.ts`)

Thin singleton. No business logic.

```typescript
import { createClient } from 'redis'
import { createHash } from 'node:crypto'

let client: ReturnType<typeof createClient> | null = null

export async function initRedis(url?: string): Promise<typeof client> {
  if (!url) return null  // graceful: no Redis URL = degraded mode
  client = createClient({ url })
  client.on('error', (err) => console.error('[redis]', err.message))
  await client.connect()
  return client
}

export function getRedis() { return client }

export const keys = {
  apiKey: (raw: string) => `oracle:apikey:${createHash('sha256').update(raw).digest('hex')}`,
  agentProfile: (id: string) => `oracle:agent:profile:${id}`,
  agentMetrics: (id: string, plan: string) => `oracle:agent:metrics:${id}:${plan}`,
  leaderboard: (version: number, sort: string, cursor: string, plan: string) =>
    `oracle:lb:v${version}:${sort}:${cursor}:${plan}`,
  leaderboardVersion: () => `oracle:lb:version`,
  protocolList: () => `oracle:protocols`,
  protocolDetail: (id: string) => `oracle:protocol:${id}`,
  protocolMetrics: (id: string, plan: string) => `oracle:protocol:metrics:${id}:${plan}`,
  rateLimit: (scope: string, key: string) => `oracle:rl:${scope}:${key}`,
}
```

### 6.2 Cache Policy

| Endpoint | Cached | TTL | Key includes plan | Invalidation trigger |
|----------|--------|-----|-------------------|---------------------|
| `agents/:id` | Yes | 30s | No (same data for all tiers) | Registration, conflict resolution |
| `agents/:id/metrics` | Yes | 60s | Yes | Registration, conflict resolution |
| `agents/leaderboard` | Yes | 60s | Yes | Versioned namespace (INCR) |
| `agents/search` | No | -- | -- | -- |
| `agents/:id/activity` | No | -- | -- | -- |
| `protocols` | Yes | 120s | No | Lucid resolver run |
| `protocols/:id` | Yes | 60s | No | Lucid resolver run |
| `protocols/:id/metrics` | Yes | 60s | Yes | Lucid resolver run |
| API key lookup | Yes | 300s | -- | Key rotation (future) |

### 6.3 Graceful Degradation

If `REDIS_URL` is not set or Redis becomes unavailable:
- Cache: all requests are cache misses (hit Postgres directly)
- Auth: API key resolution falls back to direct DB lookup
- Rate limiting: falls back to in-memory `RateLimiter` (per-instance, not globally consistent)
- API continues to function correctly; performance and rate-limit fairness degrade

---

## 7. Migration Plan

### Phase 1: Foundation (no route changes)

1. Install dependencies
2. Create `schemas/common.ts` (ProblemDetail, CursorQuery, CursorMeta, PaginatedList, ID params)
3. Create `services/redis.ts` (thin client + key builders)
4. Create `plugins/auth.ts` (API key resolution + requireTier helper)
5. Create `plugins/cache.ts` (preHandler/onSend, 200 GET/HEAD only)
6. Create `plugins/rate-limit.ts` (evaluate @fastify/rate-limit vs custom)
7. Register Swagger + TypeBox type provider on Fastify instance
8. Tests for each plugin in isolation

### Phase 2: Schema definitions (no route changes yet)

1. Create `schemas/agents.ts` (all TypeBox schemas for agent endpoints)
2. Create `schemas/protocols.ts` (all TypeBox schemas for protocol endpoints)
3. Register all schemas with `addSchema()` + `$id`
4. Verify OpenAPI generation at `/docs`

### Phase 3: Route rebuild (one route file at a time)

1. Rewrite `agents.ts` -- TypeBox schemas, plugin config, cursor pagination
2. Rewrite `protocols.ts` -- all 3 endpoints, TypeBox schemas
3. Update `v1.ts` error responses to Problem Details format
4. Update `server.ts` wiring (plugins registered before routes)
5. Update existing tests + write new tests for rebuilt routes

### Phase 4: Service layer cursor support

1. Add cursor encode/decode utilities
2. Modify `search()`, `leaderboard()`, `getActivity()` for keyset pagination
3. Keep Postgres limit/offset internally -- cursor translates to keyset WHERE
4. Tests for cursor encode/decode + keyset query generation

---

## 8. Testing Strategy

### Existing tests (30)
- Stay as regression baseline
- Update assertions for new response shapes: Problem Details errors, `{ data }` envelope, cursor meta
- Tier tests change from `x-api-tier` header to `x-api-key` with mocked auth resolution

### New tests
- **Plugin unit tests:** each plugin tested with mock Fastify instances
- **Schema validation tests:** TypeBox schemas reject invalid input, accept valid input
- **Cache tests:** verify HIT/MISS headers, TTL behavior, invalidation
- **Cursor tests:** encode/decode round-trip, keyset query generation, signed cursor tampering rejection
- **Graceful degradation tests:** API works when Redis is unavailable
- **OpenAPI snapshot test:** ensure generated spec matches expected structure

### Target: 50+ total tests for Plan 3A v2

---

## 9. What Plan 3A v2 Does NOT Include

| Deferred Item | Target |
|---------------|--------|
| ClickHouse-backed revenue/cost metrics | Plan 3B |
| SSE streaming (`/v1/oracle/stream`) | Plan 3B |
| Webhook alerts | Plan 3B |
| SDK (`@lucidai/oracle`) | Plan 3B |
| MCP tools | Plan 3B |
| Feed history endpoint | Plan 3B |
| Full `v1.ts` schema upgrade (feeds/reports) | Plan 3B |
| API usage dashboard / billing | Plan 3B |

---

## 10. Success Criteria

Plan 3A v2 is complete when:

1. All 8 endpoints have TypeBox schemas with runtime validation + fast serialization
2. OpenAPI 3.0 spec auto-generated and accessible at `/docs` with interactive Swagger UI
3. API key auth resolves tier server-side (Redis-cached, DB fallback)
4. Redis caching on 6 endpoints with correct TTLs, plan-aware keys, and explicit invalidation
5. Rate limiting on all endpoints, Redis-backed, per-plan limits
6. Cursor pagination on search, leaderboard, activity (signed, versioned)
7. RFC 9457 Problem Details on ALL error responses (including v1.ts feeds/reports)
8. Graceful degradation when Redis is unavailable
9. 50+ tests passing, 0 failures
10. Latency SLO: `/agents/:id` < 2s (99.5%) with Redis HIT < 50ms
