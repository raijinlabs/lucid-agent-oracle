# Plan 3B: MCP Tools — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 3 new API endpoints + OpenAPI annotations + Speakeasy-generated MCP server with 9 curated tools (6 free + 3 pro).

**Architecture:** New endpoints follow Plan 3A v2 patterns (TypeBox, cache, rate-limit, RFC 9457). ClickHouse methods added to `OracleClickHouse` for feed history and model usage. MCP server is a separate Speakeasy-generated process calling the Oracle REST API over HTTP.

**Tech Stack:** Fastify 5, TypeBox 0.34, ClickHouse (@clickhouse/client), Redis, Vitest, Speakeasy CLI, @noble/ed25519

**Spec:** `docs/superpowers/specs/2026-03-14-plan3b-mcp-tools-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `apps/api/src/schemas/feeds.ts` | TypeBox schemas: feed history + v1.ts route response schemas for OpenAPI |
| `apps/api/src/schemas/reports.ts` | TypeBox schemas: `VerifyReportBody`, `VerifyReportResponse` |
| `apps/api/src/routes/feeds.ts` | `registerFeedRoutes(app, clickhouse)` — feed history endpoint |
| `apps/api/src/routes/reports.ts` | `registerReportRoutes(app, clickhouse)` — verify report endpoint |
| `apps/api/src/__tests__/feed-history.test.ts` | ~6 tests for feed history |
| `apps/api/src/__tests__/model-usage.test.ts` | ~4 tests for model usage |
| `apps/api/src/__tests__/verify-report.test.ts` | ~5 tests for verify report |
| `speakeasy.yaml` | Speakeasy root config |
| `scripts/annotate-openapi.ts` | Post-processing script for `x-speakeasy-mcp` annotations |

### Modified Files

| File | Changes |
|------|---------|
| `packages/core/src/clients/clickhouse.ts` | Add `queryFeedHistory()`, `queryModelUsage()` methods + interval whitelist maps |
| `packages/core/src/index.ts` | Export new ClickHouse types if needed |
| `apps/api/src/services/redis.ts` | Add `feedHistory` and `modelUsage` key builders |
| `apps/api/src/schemas/agents.ts` | Add `ModelUsageQuery`, `ModelUsageEntry`, `ModelUsageResponse` |
| `apps/api/src/routes/agents.ts` | Add model-usage route, update signature to accept `clickhouse` param |
| `apps/api/src/routes/v1.ts` | Add TypeBox response schemas + OpenAPI tags/summary/description to all feed/report route schemas |
| `apps/api/src/server.ts` | Import + register new routes, pass `clickhouse` to feed/agent/report routes |

---

## Chunk 1: Infrastructure + Feed History Endpoint

### Task 1: ClickHouse Client — Add Feed History + Model Usage Methods

**Files:**
- Modify: `packages/core/src/clients/clickhouse.ts`

- [ ] **Step 1: Add interval/period whitelist maps and `queryFeedHistory` method**

Open `packages/core/src/clients/clickhouse.ts`. Add these after the `queryPublicationStatus` method (after line 271) and before the `close()` method:

```typescript
  // ---------------------------------------------------------------------------
  // Plan 3B: Interval/period whitelist for safe SQL interpolation
  // ---------------------------------------------------------------------------

  private static readonly INTERVAL_SQL: Record<string, string> = {
    '1m': 'INTERVAL 1 MINUTE',
    '1h': 'INTERVAL 1 HOUR',
    '1d': 'INTERVAL 1 DAY',
  }

  private static readonly PERIOD_SQL: Record<string, string> = {
    '1d': 'INTERVAL 1 DAY',
    '7d': 'INTERVAL 7 DAY',
    '30d': 'INTERVAL 30 DAY',
    '90d': 'INTERVAL 90 DAY',
  }

  /** Map user-facing interval string to safe SQL literal. Throws on invalid input. */
  private static toIntervalSql(interval: string): string {
    const sql = OracleClickHouse.INTERVAL_SQL[interval]
    if (!sql) throw new Error(`Invalid interval: ${interval}`)
    return sql
  }

  /** Map user-facing period string to safe SQL literal. Throws on invalid input. */
  private static toPeriodSql(period: string): string {
    const sql = OracleClickHouse.PERIOD_SQL[period]
    if (!sql) throw new Error(`Invalid period: ${period}`)
    return sql
  }

  // ---------------------------------------------------------------------------
  // Plan 3B: Feed history time-series
  // ---------------------------------------------------------------------------

  /** Time-series feed values bucketed by interval. */
  async queryFeedHistory(
    feedId: string,
    feedVersion: number,
    period: string,
    interval: string,
  ): Promise<Array<{ timestamp: string; value: string; confidence: number }>> {
    const periodSql = OracleClickHouse.toPeriodSql(period)
    const intervalSql = OracleClickHouse.toIntervalSql(interval)

    const result = await this.client.query({
      query: `
        SELECT
          toStartOfInterval(computed_at, ${intervalSql}) AS timestamp,
          argMax(value_json, computed_at) AS value,
          argMax(confidence, computed_at) AS confidence
        FROM published_feed_values
        WHERE feed_id = {feedId:String}
          AND feed_version = {feedVersion:UInt16}
          AND computed_at >= now() - ${periodSql}
        GROUP BY timestamp
        ORDER BY timestamp ASC
      `,
      query_params: { feedId, feedVersion },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ timestamp: string; value: string; confidence: string }>
    return rows.map((r) => ({
      timestamp: r.timestamp,
      value: r.value,
      confidence: Number(r.confidence),
    }))
  }

  // ---------------------------------------------------------------------------
  // Plan 3B: Model usage distribution
  // ---------------------------------------------------------------------------

  /** LLM model/provider distribution from raw economic events. */
  async queryModelUsage(
    period: string,
    limit: number,
  ): Promise<{ models: Array<{ model_id: string; provider: string; event_count: number }>; total_events: number }> {
    const periodSql = OracleClickHouse.toPeriodSql(period)

    const whereClause = `
      event_type = 'llm_inference'
      AND event_timestamp >= now() - ${periodSql}
      AND model_id IS NOT NULL
      AND model_id != ''
    `

    // Two queries: top-N models + true total (independent of LIMIT)
    const [modelsResult, totalResult] = await Promise.all([
      this.client.query({
        query: `
          SELECT model_id, provider, count() AS event_count
          FROM raw_economic_events
          WHERE ${whereClause}
          GROUP BY model_id, provider
          ORDER BY event_count DESC
          LIMIT {limit:UInt32}
        `,
        query_params: { limit },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: `
          SELECT count() AS total
          FROM raw_economic_events
          WHERE ${whereClause}
        `,
        format: 'JSONEachRow',
      }),
    ])

    const rows = (await modelsResult.json()) as Array<{ model_id: string; provider: string; event_count: string }>
    const totalRows = (await totalResult.json()) as Array<{ total: string }>
    const total_events = Number(totalRows[0]?.total ?? 0)

    const models = rows.map((r) => ({
      model_id: r.model_id,
      provider: r.provider,
      event_count: Number(r.event_count),
    }))
    return { models, total_events }
  }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no new type errors)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/clients/clickhouse.ts
git commit -m "feat(core): add queryFeedHistory + queryModelUsage to OracleClickHouse"
```

---

### Task 2: Redis Key Builders

**Files:**
- Modify: `apps/api/src/services/redis.ts`

- [ ] **Step 1: Add feedHistory and modelUsage key builders**

In `apps/api/src/services/redis.ts`, add two entries to the `keys` object (after the `protocolMetrics` line, before the closing `}`):

```typescript
  feedHistory: (feedId: string, period: string, interval: string, plan: string) =>
    `oracle:feed:history:${feedId}:${period}:${interval}:${plan}`,
  modelUsage: (period: string, limit: number, plan: string) =>
    `oracle:model-usage:${period}:${limit}:${plan}`,
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/redis.ts
git commit -m "feat(api): add feedHistory + modelUsage Redis key builders"
```

---

### Task 3: Feed History TypeBox Schemas

**Files:**
- Create: `apps/api/src/schemas/feeds.ts`

- [ ] **Step 1: Create the schemas file**

Create `apps/api/src/schemas/feeds.ts`:

```typescript
import { Type, type Static } from '@sinclair/typebox'
import { DataEnvelope } from './common.js'

// ---------------------------------------------------------------------------
// Feed ID params (shared with v1.ts feed routes)
// ---------------------------------------------------------------------------

export const FeedIdParams = Type.Object(
  {
    id: Type.String({ description: 'Feed identifier (aegdp, aai, apri)' }),
  },
  { $id: 'FeedIdParams' },
)

export type FeedIdParams = Static<typeof FeedIdParams>

// ---------------------------------------------------------------------------
// Feed History
// ---------------------------------------------------------------------------

export const FeedHistoryQuery = Type.Object(
  {
    period: Type.Optional(
      Type.Union([
        Type.Literal('1d'),
        Type.Literal('7d'),
        Type.Literal('30d'),
        Type.Literal('90d'),
      ], { default: '7d' }),
    ),
    interval: Type.Optional(
      Type.Union([
        Type.Literal('1m'),
        Type.Literal('1h'),
        Type.Literal('1d'),
      ], { default: '1h' }),
    ),
  },
  { $id: 'FeedHistoryQuery' },
)

export type FeedHistoryQuery = Static<typeof FeedHistoryQuery>

export const FeedHistoryPoint = Type.Object({
  timestamp: Type.String(),
  value: Type.String(),
  confidence: Type.Number(),
})

export type FeedHistoryPoint = Static<typeof FeedHistoryPoint>

const FeedHistoryData = Type.Object({
  feed_id: Type.String(),
  period: Type.String(),
  interval: Type.String(),
  has_data: Type.Boolean(),
  points: Type.Array(FeedHistoryPoint),
})

export const FeedHistoryResponse = DataEnvelope(FeedHistoryData, 'FeedHistoryResponse')

export type FeedHistoryResponse = Static<typeof FeedHistoryResponse>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/feeds.ts
git commit -m "feat(api): add TypeBox schemas for feed history endpoint"
```

---

### Task 4: Feed History Route + Tests

**Files:**
- Create: `apps/api/src/routes/feeds.ts`
- Create: `apps/api/src/__tests__/feed-history.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/api/src/__tests__/feed-history.test.ts`:

```typescript
process.env.CURSOR_SECRET = 'test-cursor-secret-32chars-long!'

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { registerFeedRoutes } from '../routes/feeds.js'
import { ProblemDetail } from '../schemas/common.js'

// ---------------------------------------------------------------------------
// Mock ClickHouse
// ---------------------------------------------------------------------------

function mockClickHouse() {
  return {
    queryFeedHistory: vi.fn().mockResolvedValue([]),
    queryPublicationStatus: vi.fn().mockResolvedValue(null),
  }
}

// ---------------------------------------------------------------------------
// Mock auth plugin
// ---------------------------------------------------------------------------

const mockAuthPlugin = fp(
  async (fastify) => {
    fastify.decorateRequest('tenant', null as unknown as { id: string | null; plan: string })
    fastify.addHook('onRequest', async (request) => {
      const key = request.headers['x-api-key']
      if (key === 'pro-key') {
        request.tenant = { id: 'tenant_pro', plan: 'pro' }
      } else if (key === 'growth-key') {
        request.tenant = { id: 'tenant_growth', plan: 'growth' }
      } else {
        request.tenant = { id: null, plan: 'free' }
      }
    })
  },
  { name: 'auth', fastify: '5.x' },
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Feed history routes', () => {
  const ch = mockClickHouse()
  const app = Fastify()

  beforeAll(async () => {
    app.addSchema(ProblemDetail)
    await app.register(mockAuthPlugin)
    registerFeedRoutes(app, ch as any)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    ch.queryFeedHistory.mockReset().mockResolvedValue([])
  })

  // ---- 1. Returns time-series for valid feed_id ----
  it('returns time-series for valid feed_id', async () => {
    ch.queryFeedHistory.mockResolvedValueOnce([
      { timestamp: '2026-03-13T00:00:00Z', value: '{"value_usd":12345.67}', confidence: 0.85 },
      { timestamp: '2026-03-13T01:00:00Z', value: '{"value_usd":12400.00}', confidence: 0.87 },
    ])
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp/history' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.feed_id).toBe('aegdp')
    expect(body.data.has_data).toBe(true)
    expect(body.data.points).toHaveLength(2)
    expect(body.data.points[0].confidence).toBe(0.85)
  })

  // ---- 2. Returns has_data: false with empty points ----
  it('returns has_data: false with empty points when no data', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aai/history' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.has_data).toBe(false)
    expect(body.data.points).toEqual([])
  })

  // ---- 3. Rejects invalid feed_id (404) ----
  it('rejects invalid feed_id with 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/invalid/history' })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.type).toContain('not-found')
  })

  // ---- 4. Free tier capped at 7d (403 for 30d) ----
  it('rejects 30d period for free tier with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/feeds/aegdp/history?period=30d',
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.type).toContain('tier-required')
  })

  // ---- 5. Pro tier can access 30d ----
  it('allows 30d period for pro tier', async () => {
    ch.queryFeedHistory.mockResolvedValueOnce([])
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/feeds/aegdp/history?period=30d',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.period).toBe('30d')
  })

  // ---- 6. Handles null clickhouse gracefully ----
  it('returns empty data when clickhouse is null', async () => {
    const nullApp = Fastify()
    nullApp.addSchema(ProblemDetail)
    await nullApp.register(mockAuthPlugin)
    registerFeedRoutes(nullApp, null)
    await nullApp.ready()

    const res = await nullApp.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp/history' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.has_data).toBe(false)
    expect(body.data.points).toEqual([])

    await nullApp.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/feed-history.test.ts`
Expected: FAIL — `Cannot find module '../routes/feeds.js'`

- [ ] **Step 3: Write the route implementation**

Create `apps/api/src/routes/feeds.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import type { OracleClickHouse } from '@lucid/oracle-core'
import { V1_FEEDS, type FeedId } from '@lucid/oracle-core'
import { sendProblem } from '../schemas/common.js'
import { FeedIdParams, FeedHistoryQuery, FeedHistoryResponse } from '../schemas/feeds.js'
import { keys } from '../services/redis.js'

/** Periods that require pro tier or higher. */
const PRO_PERIODS = new Set(['30d', '90d'])

export function registerFeedRoutes(
  app: FastifyInstance,
  clickhouse: OracleClickHouse | null,
): void {

  // ---- GET /v1/oracle/feeds/:id/history ----
  app.get<{ Params: { id: string }; Querystring: { period?: string; interval?: string } }>(
    '/v1/oracle/feeds/:id/history',
    {
      schema: {
        tags: ['feeds'],
        summary: 'Get feed history',
        description: 'Time-series feed values from ClickHouse. Free tier limited to 7d. Pro/Growth up to 90d.',
        params: FeedIdParams,
        querystring: FeedHistoryQuery,
        response: {
          200: FeedHistoryResponse,
          403: { $ref: 'ProblemDetail' },
          404: { $ref: 'ProblemDetail' },
        },
      },
      config: {
        cache: {
          ttl: 60,
          key: (request: { params: Record<string, string>; query: Record<string, string>; tenant?: { plan: string } }) => {
            const period = request.query.period ?? '7d'
            const interval = request.query.interval ?? '1h'
            const plan = request.tenant?.plan ?? 'free'
            return keys.feedHistory(request.params.id, period, interval, plan)
          },
        },
        rateLimit: { max: 30 },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const period = request.query.period ?? '7d'
      const interval = request.query.interval ?? '1h'

      // Validate feed exists
      const feedDef = V1_FEEDS[id as FeedId]
      if (!feedDef) {
        return sendProblem(reply, 404, {
          type: 'not-found',
          title: 'Feed Not Found',
          detail: `No feed found with id '${id}'.`,
          code: 'FEED_NOT_FOUND',
        })
      }

      // Tier gate: 30d/90d require pro
      if (PRO_PERIODS.has(period)) {
        const plan = request.tenant?.plan ?? 'free'
        if (plan === 'free') {
          return sendProblem(reply, 403, {
            type: 'tier-required',
            title: 'Insufficient Plan Tier',
            detail: `Period '${period}' requires plan 'pro' or higher. Your current plan is 'free'.`,
            code: 'TIER_REQUIRED',
          })
        }
      }

      // ClickHouse not available → empty data
      if (!clickhouse) {
        return reply.send({
          data: {
            feed_id: id,
            period,
            interval,
            has_data: false,
            points: [],
          },
        })
      }

      const points = await clickhouse.queryFeedHistory(id, feedDef.version, period, interval)

      return reply.send({
        data: {
          feed_id: id,
          period,
          interval,
          has_data: points.length > 0,
          points,
        },
      })
    },
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/feed-history.test.ts`
Expected: PASS (6/6 tests)

- [ ] **Step 5: Run full test suite**

Run: `CURSOR_SECRET=test npm test`
Expected: All existing tests still pass + 6 new tests

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/feeds.ts apps/api/src/schemas/feeds.ts apps/api/src/__tests__/feed-history.test.ts
git commit -m "feat(api): add GET /feeds/:id/history endpoint with tests"
```

---

## Chunk 2: Model Usage + Verify Report Endpoints

### Task 5: Model Usage TypeBox Schemas

**Files:**
- Modify: `apps/api/src/schemas/agents.ts`

- [ ] **Step 1: Add model usage schemas to agents.ts**

Append to the end of `apps/api/src/schemas/agents.ts` (after `ActivityResponse`):

```typescript
// ---------------------------------------------------------------------------
// 15. ModelUsageQuery ($id: 'ModelUsageQuery')
// ---------------------------------------------------------------------------

export const ModelUsageQuery = Type.Object(
  {
    period: Type.Optional(
      Type.Union([
        Type.Literal('1d'),
        Type.Literal('7d'),
        Type.Literal('30d'),
      ], { default: '7d' }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
    ),
  },
  { $id: 'ModelUsageQuery' },
)

export type ModelUsageQuery = Static<typeof ModelUsageQuery>

// ---------------------------------------------------------------------------
// 16. ModelUsageEntry (sub-schema, no $id)
// ---------------------------------------------------------------------------

export const ModelUsageEntry = Type.Object({
  model_id: Type.String(),
  provider: Type.String(),
  event_count: Type.Integer(),
  pct: Type.Number(),
})

export type ModelUsageEntry = Static<typeof ModelUsageEntry>

// ---------------------------------------------------------------------------
// 17. ModelUsageResponse ($id: 'ModelUsageResponse')
// ---------------------------------------------------------------------------

const ModelUsageData = Type.Object({
  period: Type.String(),
  has_data: Type.Boolean(),
  models: Type.Array(ModelUsageEntry),
  total_events: Type.Integer(),
})

export const ModelUsageResponse = DataEnvelope(ModelUsageData, 'ModelUsageResponse')

export type ModelUsageResponse = Static<typeof ModelUsageResponse>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/agents.ts
git commit -m "feat(api): add TypeBox schemas for model usage endpoint"
```

---

### Task 6: Model Usage Route + Tests

**Files:**
- Modify: `apps/api/src/routes/agents.ts`
- Create: `apps/api/src/__tests__/model-usage.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/api/src/__tests__/model-usage.test.ts`:

```typescript
process.env.CURSOR_SECRET = 'test-cursor-secret-32chars-long!'

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { registerAgentRoutes } from '../routes/agents.js'
import { ProblemDetail } from '../schemas/common.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockClickHouse() {
  return {
    queryModelUsage: vi.fn().mockResolvedValue({ models: [], total_events: 0 }),
  }
}

const mockAuthPlugin = fp(
  async (fastify) => {
    fastify.decorateRequest('tenant', null as unknown as { id: string | null; plan: string })
    fastify.addHook('onRequest', async (request) => {
      const key = request.headers['x-api-key']
      if (key === 'pro-key') {
        request.tenant = { id: 'tenant_pro', plan: 'pro' }
      } else if (key === 'growth-key') {
        request.tenant = { id: 'tenant_growth', plan: 'growth' }
      } else {
        request.tenant = { id: null, plan: 'free' }
      }
    })
  },
  { name: 'auth', fastify: '5.x' },
)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Model usage route', () => {
  const db = mockDb()
  const ch = mockClickHouse()
  const app = Fastify()

  beforeAll(async () => {
    app.addSchema(ProblemDetail)
    await app.register(mockAuthPlugin)
    registerAgentRoutes(app, db as any, ch as any)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    db.query.mockReset().mockResolvedValue({ rows: [] })
    ch.queryModelUsage.mockReset().mockResolvedValue({ models: [], total_events: 0 })
  })

  // ---- 1. Returns model breakdown with percentages ----
  it('returns model breakdown with percentages for pro tier', async () => {
    ch.queryModelUsage.mockResolvedValueOnce({
      models: [
        { model_id: 'claude-sonnet-4-5', provider: 'anthropic', event_count: 600 },
        { model_id: 'gpt-4o', provider: 'openai', event_count: 400 },
      ],
      total_events: 1000,
    })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/model-usage',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.has_data).toBe(true)
    expect(body.data.models).toHaveLength(2)
    expect(body.data.models[0].pct).toBe(60.0)
    expect(body.data.models[1].pct).toBe(40.0)
    expect(body.data.total_events).toBe(1000)
  })

  // ---- 2. Returns has_data: false when empty ----
  it('returns has_data: false when empty', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/model-usage',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.has_data).toBe(false)
    expect(body.data.models).toEqual([])
    expect(body.data.total_events).toBe(0)
  })

  // ---- 3. Requires pro tier (403 for free) ----
  it('returns 403 for free tier', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/model-usage',
    })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.type).toContain('tier-required')
  })

  // ---- 4. Respects limit parameter ----
  it('passes limit parameter to ClickHouse', async () => {
    ch.queryModelUsage.mockResolvedValueOnce({ models: [], total_events: 0 })
    await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/model-usage?limit=5',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(ch.queryModelUsage).toHaveBeenCalledWith('7d', 5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/model-usage.test.ts`
Expected: FAIL — `registerAgentRoutes` signature changed (now expects 3 args)

- [ ] **Step 3: Update the route file**

In `apps/api/src/routes/agents.ts`:

**3a.** Update imports — add model usage schemas:

```typescript
import {
  AgentSearchQuery,
  AgentSearchResponse,
  LeaderboardQuery,
  LeaderboardResponse,
  AgentProfileResponse,
  AgentMetricsResponse,
  ActivityQuery,
  ActivityResponse,
  ModelUsageQuery,
  ModelUsageResponse,
} from '../schemas/agents.js'
```

**3b.** Add `OracleClickHouse` import:

```typescript
import type { OracleClickHouse } from '@lucid/oracle-core'
```

**3c.** Update function signature:

```typescript
export function registerAgentRoutes(
  app: FastifyInstance,
  db: DbClient,
  clickhouse?: OracleClickHouse | null,
): void {
```

Note: `clickhouse` is optional to preserve backward compatibility with existing tests.

**3d.** Add the model-usage route BEFORE the `/:id` route (after `search`, after `leaderboard`, before `/:id`). Insert before line 170 (`// ---- GET /v1/oracle/agents/:id (Free) ----`):

```typescript
  // ---- GET /v1/oracle/agents/model-usage (Pro) ----
  // MUST be registered before /:id to avoid "model-usage" matching as :id param
  app.get('/v1/oracle/agents/model-usage', {
    schema: {
      tags: ['agents'],
      summary: 'Get model usage distribution',
      description: 'LLM model/provider distribution across the agent economy. Requires pro tier.',
      querystring: ModelUsageQuery,
      security: [{ apiKey: [] }],
      response: {
        200: ModelUsageResponse,
        403: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
    config: {
      cache: {
        ttl: 120,
        key: (request: { query: Record<string, string>; tenant?: { plan: string } }) => {
          const period = request.query.period ?? '7d'
          const limit = request.query.limit ?? '20'
          const plan = request.tenant?.plan ?? 'free'
          return keys.modelUsage(period, Number(limit), plan)
        },
      },
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const query = request.query as { period?: string; limit?: number }
    const period = query.period ?? '7d'
    const limit = query.limit ?? 20

    // ClickHouse not available → empty data
    if (!clickhouse) {
      return reply.send({
        data: { period, has_data: false, models: [], total_events: 0 },
      })
    }

    const result = await clickhouse.queryModelUsage(period, limit)

    const models = result.models.map((m) => ({
      ...m,
      pct: result.total_events > 0
        ? Math.round((m.event_count / result.total_events) * 1000) / 10
        : 0,
    }))

    return reply.send({
      data: {
        period,
        has_data: models.length > 0,
        models,
        total_events: result.total_events,
      },
    })
  })
```

- [ ] **Step 4: Run model-usage tests**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/model-usage.test.ts`
Expected: PASS (4/4 tests)

- [ ] **Step 5: Run existing agent-routes tests to verify no regression**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/agent-routes.test.ts`
Expected: PASS (10/10 existing tests still pass — `clickhouse` param is optional)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents.ts apps/api/src/__tests__/model-usage.test.ts
git commit -m "feat(api): add GET /agents/model-usage endpoint with tests"
```

---

### Task 7: Verify Report TypeBox Schemas

**Files:**
- Create: `apps/api/src/schemas/reports.ts`

- [ ] **Step 1: Create the schemas file**

Create `apps/api/src/schemas/reports.ts`:

```typescript
import { Type, type Static } from '@sinclair/typebox'
import { DataEnvelope } from './common.js'

// ---------------------------------------------------------------------------
// Verify Report request body — matches ReportEnvelope from oracle-core
// ---------------------------------------------------------------------------

const ReportSignature = Type.Object({
  signer: Type.String(),
  sig: Type.String(),
})

const ReportEnvelopeSchema = Type.Object({
  feed_id: Type.String(),
  feed_version: Type.Integer(),
  report_timestamp: Type.Number(),
  values: Type.Record(Type.String(), Type.Unknown()),
  input_manifest_hash: Type.String(),
  computation_hash: Type.String(),
  revision: Type.Integer(),
  signer_set_id: Type.String(),
  signatures: Type.Array(ReportSignature, { minItems: 1 }),
})

export const VerifyReportBody = Type.Object(
  {
    report: ReportEnvelopeSchema,
  },
  { $id: 'VerifyReportBody' },
)

export type VerifyReportBody = Static<typeof VerifyReportBody>

// ---------------------------------------------------------------------------
// Verify Report response
// ---------------------------------------------------------------------------

const VerifyChecks = Type.Object({
  signature: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
  payload_integrity: Type.Union([Type.Literal('pass'), Type.Literal('fail')]),
  signer_set_id: Type.String(),
  signers: Type.Array(Type.String()),
})

const VerifyPublication = Type.Object({
  solana_tx: Type.Union([Type.String(), Type.Null()]),
  base_tx: Type.Union([Type.String(), Type.Null()]),
})

const VerifyReportData = Type.Object({
  valid: Type.Boolean(),
  checks: VerifyChecks,
  publication: VerifyPublication,
})

export const VerifyReportResponse = DataEnvelope(VerifyReportData, 'VerifyReportResponse')

export type VerifyReportResponse = Static<typeof VerifyReportResponse>
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/schemas/reports.ts
git commit -m "feat(api): add TypeBox schemas for verify report endpoint"
```

---

### Task 8: Verify Report Route + Tests

**Files:**
- Create: `apps/api/src/routes/reports.ts`
- Create: `apps/api/src/__tests__/verify-report.test.ts`

- [ ] **Step 1: Write the test file**

Create `apps/api/src/__tests__/verify-report.test.ts`:

```typescript
process.env.CURSOR_SECRET = 'test-cursor-secret-32chars-long!'

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { AttestationService } from '@lucid/oracle-core'
import type { ReportPayload } from '@lucid/oracle-core'
import { registerReportRoutes } from '../routes/reports.js'
import { ProblemDetail } from '../schemas/common.js'

// ---------------------------------------------------------------------------
// Mock ClickHouse
// ---------------------------------------------------------------------------

function mockClickHouse() {
  return {
    queryPublicationStatus: vi.fn().mockResolvedValue(null),
  }
}

// ---------------------------------------------------------------------------
// Mock auth plugin
// ---------------------------------------------------------------------------

const mockAuthPlugin = fp(
  async (fastify) => {
    fastify.decorateRequest('tenant', null as unknown as { id: string | null; plan: string })
    fastify.addHook('onRequest', async (request) => {
      request.tenant = { id: null, plan: 'free' }
    })
  },
  { name: 'auth', fastify: '5.x' },
)

// ---------------------------------------------------------------------------
// Helper: create a valid signed report
// ---------------------------------------------------------------------------

const attestation = new AttestationService({ seed: 'test-seed' })

function makePayload(): ReportPayload {
  return {
    feed_id: 'aegdp',
    feed_version: 1,
    report_timestamp: 1741824000000,
    values: { value_usd: 12345.67 },
    input_manifest_hash: 'abc123',
    computation_hash: 'def456',
    revision: 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Verify report routes', () => {
  const ch = mockClickHouse()
  const app = Fastify()

  beforeAll(async () => {
    app.addSchema(ProblemDetail)
    await app.register(mockAuthPlugin)
    registerReportRoutes(app, ch as any)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    ch.queryPublicationStatus.mockReset().mockResolvedValue(null)
  })

  // ---- 1. Valid report passes all checks ----
  it('valid report passes all checks', async () => {
    const envelope = attestation.signReport(makePayload())
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oracle/reports/verify',
      payload: { report: envelope },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.valid).toBe(true)
    expect(body.data.checks.signature).toBe('pass')
    expect(body.data.checks.payload_integrity).toBe('pass')
    expect(body.data.checks.signer_set_id).toBe('ss_lucid_v1')
    expect(body.data.checks.signers).toHaveLength(1)
  })

  // ---- 2. Tampered signature fails ----
  it('tampered signature fails', async () => {
    const envelope = attestation.signReport(makePayload())
    // Flip a character in the signature
    envelope.signatures[0].sig = 'ff' + envelope.signatures[0].sig.slice(2)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oracle/reports/verify',
      payload: { report: envelope },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.valid).toBe(false)
    expect(body.data.checks.signature).toBe('fail')
  })

  // ---- 3. Tampered payload fails both signature and integrity ----
  it('tampered payload fails both checks', async () => {
    const envelope = attestation.signReport(makePayload())
    // Tamper with the payload after signing — signature will fail because
    // canonical payload changed, and integrity is derived from signature
    envelope.values = { value_usd: 99999 }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oracle/reports/verify',
      payload: { report: envelope },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.valid).toBe(false)
    expect(body.data.checks.signature).toBe('fail')
    expect(body.data.checks.payload_integrity).toBe('fail')
  })

  // ---- 4. Returns publication tx hashes when available ----
  it('returns publication tx hashes when available', async () => {
    ch.queryPublicationStatus.mockResolvedValueOnce({
      published_solana: 'sol_tx_abc123',
      published_base: null,
      pub_status_rev: 1,
    })
    const envelope = attestation.signReport(makePayload())
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oracle/reports/verify',
      payload: { report: envelope },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.publication.solana_tx).toBe('sol_tx_abc123')
    expect(body.data.publication.base_tx).toBeNull()
  })

  // ---- 5. Returns null publication when no on-chain data ----
  it('returns null publication when no on-chain data', async () => {
    ch.queryPublicationStatus.mockResolvedValueOnce(null)
    const envelope = attestation.signReport(makePayload())
    const res = await app.inject({
      method: 'POST',
      url: '/v1/oracle/reports/verify',
      payload: { report: envelope },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data.publication.solana_tx).toBeNull()
    expect(body.data.publication.base_tx).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/verify-report.test.ts`
Expected: FAIL — `Cannot find module '../routes/reports.js'`

- [ ] **Step 3: Write the route implementation**

Create `apps/api/src/routes/reports.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import {
  AttestationService,
  type ReportEnvelope,
  type OracleClickHouse,
  V1_FEEDS,
  type FeedId,
} from '@lucid/oracle-core'
import { VerifyReportBody, VerifyReportResponse } from '../schemas/reports.js'

export function registerReportRoutes(
  app: FastifyInstance,
  clickhouse: OracleClickHouse | null,
): void {
  // Single instance — verifyReport() uses the envelope's public keys, not this service's key
  const attestation = new AttestationService({ seed: 'verify-only' })

  // ---- POST /v1/oracle/reports/verify ----
  app.post('/v1/oracle/reports/verify', {
    schema: {
      tags: ['reports'],
      summary: 'Verify oracle report',
      description: 'Verify a signed oracle report envelope — Ed25519 signature + payload integrity + publication status.',
      body: VerifyReportBody,
      response: {
        200: VerifyReportResponse,
        400: { $ref: 'ProblemDetail' },
      },
    },
    config: {
      rateLimit: { max: 10 },
    },
  }, async (request, reply) => {
    const { report } = request.body as { report: ReportEnvelope }

    // 1. Signature check — verifyReport() strips signer_set_id/signatures,
    //    canonicalizes the remaining ReportPayload, and verifies each Ed25519 signature.
    let signaturePass = false
    try {
      signaturePass = attestation.verifyReport(report)
    } catch {
      signaturePass = false
    }

    // 2. Payload integrity — if the signature over the canonical payload verifies,
    //    the payload has not been tampered with. Signature verification IS the
    //    integrity check (the sig covers the exact canonical JSON of the payload).
    //    A separate hash comparison is not needed and computation_hash is the
    //    code-version hash, not a payload hash.
    const integrityPass = signaturePass

    // 3. Publication lookup (optional — depends on ClickHouse availability)
    //    Convert report_timestamp (epoch ms) → ISO string to match computed_at column.
    let solanaTx: string | null = null
    let baseTx: string | null = null

    if (clickhouse && report.feed_id) {
      const feedDef = V1_FEEDS[report.feed_id as FeedId]
      if (feedDef) {
        try {
          const computedAt = new Date(report.report_timestamp).toISOString()
          const pub = await clickhouse.queryPublicationStatus(
            report.feed_id,
            feedDef.version,
            computedAt,
            report.revision,
          )
          if (pub) {
            solanaTx = pub.published_solana
            baseTx = pub.published_base
          }
        } catch {
          // Publication lookup failure is non-fatal
        }
      }
    }

    const valid = signaturePass && integrityPass

    return reply.send({
      data: {
        valid,
        checks: {
          signature: signaturePass ? 'pass' : 'fail',
          payload_integrity: integrityPass ? 'pass' : 'fail',
          signer_set_id: report.signer_set_id,
          signers: report.signatures.map((s) => s.signer),
        },
        publication: {
          solana_tx: solanaTx,
          base_tx: baseTx,
        },
      },
    })
  })
}
```

- [ ] **Step 4: Run tests**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose apps/api/src/__tests__/verify-report.test.ts`
Expected: PASS (5/5 tests)

- [ ] **Step 5: Run full test suite**

Run: `CURSOR_SECRET=test npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/reports.ts apps/api/src/__tests__/verify-report.test.ts
git commit -m "feat(api): add POST /reports/verify endpoint with tests"
```

---

## Chunk 3: OpenAPI Annotations + Integration + MCP

### Task 9: OpenAPI Schemas + Annotations on Existing Routes

**Files:**
- Modify: `apps/api/src/schemas/feeds.ts` (add response schemas for existing routes)
- Modify: `apps/api/src/routes/v1.ts`

Speakeasy generates MCP tools from OpenAPI. The existing v1.ts routes have no `schema` block — Speakeasy needs typed request/response schemas to generate useful tool input/output shapes, not just tags/summary/description.

- [ ] **Step 1: Add response schemas to feeds.ts for existing v1.ts routes**

Append to `apps/api/src/schemas/feeds.ts` (after `FeedHistoryResponse`):

```typescript
// ---------------------------------------------------------------------------
// V1 existing route schemas (needed for OpenAPI completeness → Speakeasy)
// ---------------------------------------------------------------------------

const FeedValuePublic = Type.Object({
  feed_id: Type.String(),
  value: Type.String(),
  confidence: Type.Number(),
  completeness: Type.Number(),
  freshness_ms: Type.Integer(),
  staleness_risk: Type.String(),
  computed_at: Type.String(),
  signer: Type.String(),
  signature: Type.String(),
})

const FeedDefPublic = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  version: Type.Integer(),
  methodology_url: Type.String(),
  update_interval_ms: Type.Integer(),
  deviation_threshold_bps: Type.Integer(),
  latest_value: Type.Union([FeedValuePublic, Type.Null()]),
})

export const FeedListResponse = Type.Object(
  { feeds: Type.Array(FeedDefPublic) },
  { $id: 'FeedListResponse' },
)

export const FeedDetailResponse = Type.Object(
  {
    feed: Type.Object({
      id: Type.String(),
      name: Type.String(),
      description: Type.String(),
      version: Type.Integer(),
      methodology_url: Type.String(),
    }),
    latest: Type.Union([FeedValuePublic, Type.Null()]),
    methodology_url: Type.String(),
  },
  { $id: 'FeedDetailResponse' },
)

export const FeedMethodologyResponse = Type.Object(
  {
    feed_id: Type.String(),
    version: Type.Integer(),
    name: Type.String(),
    description: Type.String(),
    update_interval_ms: Type.Integer(),
    deviation_threshold_bps: Type.Integer(),
    confidence_formula: Type.Object({
      version: Type.Integer(),
      weights: Type.Record(Type.String(), Type.Number()),
    }),
    computation: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    canonical_json_version: Type.Optional(Type.String()),
  },
  { $id: 'FeedMethodologyResponse' },
)

export const ReportLatestResponse = Type.Object(
  {
    report: Type.Union([
      Type.Object({ feeds: Type.Array(FeedValuePublic) }),
      Type.Null(),
    ]),
  },
  { $id: 'ReportLatestResponse' },
)
```

- [ ] **Step 2: Add schemas + annotations to v1.ts feed routes**

In `apps/api/src/routes/v1.ts`, add the import:

```typescript
import {
  FeedIdParams,
  FeedListResponse,
  FeedDetailResponse,
  FeedMethodologyResponse,
  ReportLatestResponse,
} from '../schemas/feeds.js'
```

Then add `app.addSchema()` calls at the start of `registerOracleRoutes`:

```typescript
export function registerOracleRoutes(app: FastifyInstance): void {
  // Register response schemas for OpenAPI
  app.addSchema(FeedListResponse)
  app.addSchema(FeedDetailResponse)
  app.addSchema(FeedMethodologyResponse)
  app.addSchema(ReportLatestResponse)
```

Update each route definition to include full schema blocks:

**`GET /v1/oracle/feeds` (line 78):**

```typescript
  app.get('/v1/oracle/feeds', {
    schema: {
      tags: ['feeds'],
      summary: 'List all feeds',
      description: 'Current state of the agent economy — all 3 feed values with confidence and freshness.',
      response: { 200: FeedListResponse },
    },
  }, async () => {
```

**`GET /v1/oracle/feeds/:id` (line 88):**

```typescript
  app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id', {
    schema: {
      tags: ['feeds'],
      summary: 'Get feed detail',
      description: 'Deep dive on a single feed with its latest value and methodology URL.',
      params: FeedIdParams,
      response: {
        200: FeedDetailResponse,
        404: { $ref: 'ProblemDetail' },
      },
    },
  }, async (request, reply) => {
```

**`GET /v1/oracle/feeds/:id/methodology` (line 109):**

```typescript
  app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id/methodology', {
    schema: {
      tags: ['feeds'],
      summary: 'Get feed methodology',
      description: 'Detailed methodology for a feed including computation formula, weights, and anchors.',
      params: FeedIdParams,
      response: {
        200: FeedMethodologyResponse,
        404: { $ref: 'ProblemDetail' },
      },
    },
  }, async (request, reply) => {
```

**`GET /v1/oracle/reports/latest` (line 183):**

```typescript
  app.get('/v1/oracle/reports/latest', {
    schema: {
      tags: ['reports'],
      summary: 'Get latest report',
      description: 'Latest signed oracle report with all feed values.',
      response: { 200: ReportLatestResponse },
    },
  }, async () => {
```

- [ ] **Step 3: Run tests**

Run: `CURSOR_SECRET=test npm test`
Expected: All tests still pass (response schemas are serialization hints, not validation gates on response)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/schemas/feeds.ts apps/api/src/routes/v1.ts
git commit -m "feat(api): add TypeBox response schemas + OpenAPI annotations to v1.ts routes"
```

---

### Task 10: server.ts Integration — Register New Routes

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add imports for new routes**

At the top of `apps/api/src/server.ts`, after line 24 (`import { registerProtocolRoutes } from './routes/protocols.js'`), add:

```typescript
import { registerFeedRoutes } from './routes/feeds.js'
import { registerReportRoutes } from './routes/reports.js'
```

- [ ] **Step 2: Register new routes in the DB block**

In `server.ts`, find the line (currently ~234):
```typescript
  registerAgentRoutes(app, client)
```

Replace with:
```typescript
  registerAgentRoutes(app, client, clickhouse)
```

Then after `registerProtocolRoutes(app, client)` (currently ~235), add:

```typescript
  registerFeedRoutes(app, clickhouse)
  registerReportRoutes(app, clickhouse)
```

And update the log line from:
```typescript
  app.log.info('Agent query + protocol routes mounted')
```
To:
```typescript
  app.log.info('Agent, protocol, feed, and report routes mounted')
```

- [ ] **Step 3: Run tests**

Run: `CURSOR_SECRET=test npm test`
Expected: All tests pass

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): register feed history, model usage, and verify report routes in server.ts"
```

---

### Task 11: Full Test Suite Verification

- [ ] **Step 1: Run the complete test suite**

Run: `CURSOR_SECRET=test npm test -- --reporter verbose`
Expected: All existing tests (242) + new tests (~15) = **257+ total**, 0 failures.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: If any failures, fix and re-run**

Fix any test regressions. Common issues:
- `registerAgentRoutes` signature change: existing test passes `(app, db)` — the `clickhouse` param is optional so this should be fine
- Import resolution: ensure all `.js` extensions are present in imports

---

### Task 12: OpenAPI Annotation Post-Processing Script

**Files:**
- Create: `scripts/annotate-openapi.ts`

This script adds `x-speakeasy-mcp` annotations to the exported OpenAPI spec before Speakeasy generation.

- [ ] **Step 1: Create the annotation script**

Create `scripts/annotate-openapi.ts`:

```typescript
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Post-process openapi.json to add x-speakeasy-mcp annotations.
 * Run after: curl http://localhost:4040/docs/json > openapi.json
 * Run before: speakeasy generate
 */

interface OpenAPISpec {
  paths: Record<string, Record<string, { 'x-speakeasy-mcp'?: Record<string, unknown> }>>
}

// Tool mappings: path+method → tool config
const TOOL_ANNOTATIONS: Record<string, { method: string; tool: Record<string, unknown> }> = {
  '/v1/oracle/feeds': {
    method: 'get',
    tool: { 'tool-name': 'oracle_economy_snapshot', description: 'Get current state of the agent economy — AEGDP, AAI, APRI feed values with confidence and freshness.' },
  },
  '/v1/oracle/feeds/{id}': {
    method: 'get',
    tool: { 'tool-name': 'oracle_feed_value', description: 'Deep dive on a single oracle feed with its latest value and methodology context.' },
  },
  '/v1/oracle/feeds/{id}/methodology': {
    method: 'get',
    tool: { 'tool-name': 'oracle_feed_value', description: 'Feed methodology detail — grouped with oracle_feed_value.' },
  },
  '/v1/oracle/feeds/{id}/history': {
    method: 'get',
    tool: { 'tool-name': 'oracle_feed_history', description: 'Time-series feed values for trend analysis. Empty results mean no data for the period, not an error.' },
  },
  '/v1/oracle/agents/search': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_search', description: 'Find agents by wallet, protocol, ERC-8004 ID, or name.' },
  },
  '/v1/oracle/agents/{id}': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_lookup', description: 'Agent profile — wallets, protocols, reputation, stats.' },
  },
  '/v1/oracle/agents/{id}/metrics': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_deep_metrics', description: 'Full agent dossier — wallet/evidence/protocol breakdowns. Requires pro tier.' },
  },
  '/v1/oracle/agents/{id}/activity': {
    method: 'get',
    tool: { 'tool-name': 'oracle_agent_deep_metrics', description: 'Agent activity feed — grouped with oracle_agent_deep_metrics.' },
  },
  '/v1/oracle/agents/model-usage': {
    method: 'get',
    tool: { 'tool-name': 'oracle_model_usage', description: 'LLM model/provider distribution across the agent economy. Empty results mean no data, not an error.' },
  },
  '/v1/oracle/protocols': {
    method: 'get',
    tool: { 'tool-name': 'oracle_protocol_stats', description: 'Protocol listing with chain support and status.' },
  },
  '/v1/oracle/protocols/{id}': {
    method: 'get',
    tool: { 'tool-name': 'oracle_protocol_stats', description: 'Protocol detail with agent/wallet counts — grouped with oracle_protocol_stats.' },
  },
  '/v1/oracle/reports/verify': {
    method: 'post',
    tool: { 'tool-name': 'oracle_verify_report', description: 'Verify signed oracle report — Ed25519 signature + payload integrity + publication status.' },
  },
}

// Explicitly disabled endpoints (exclude from MCP)
const DISABLED_PATHS: Record<string, string> = {
  '/v1/oracle/reports/latest': 'get',
  '/v1/oracle/agents/leaderboard': 'get',
  '/v1/oracle/protocols/{id}/metrics': 'get',
  '/health': 'get',
  // Identity/admin routes — internal, must not become MCP tools
  '/v1/oracle/agents/challenge': 'post',
  '/v1/oracle/agents/register': 'post',
  '/v1/internal/identity/conflicts': 'get',
  '/v1/internal/identity/conflicts/{id}': 'get',
  '/v1/internal/identity/conflicts/{id}': 'patch',
  '/v1/internal/identity/resolve-lucid': 'post',
}

const specPath = process.argv[2] ?? 'openapi.json'
const spec = JSON.parse(readFileSync(specPath, 'utf-8')) as OpenAPISpec
let warnings = 0

// Add tool annotations
for (const [path, config] of Object.entries(TOOL_ANNOTATIONS)) {
  const pathObj = spec.paths[path]
  if (pathObj?.[config.method]) {
    pathObj[config.method]['x-speakeasy-mcp'] = config.tool
  } else {
    console.warn(`WARNING: Tool path not found in spec: ${config.method.toUpperCase()} ${path}`)
    warnings++
  }
}

// Disable explicitly listed endpoints
for (const [path, method] of Object.entries(DISABLED_PATHS)) {
  const pathObj = spec.paths[path]
  if (pathObj?.[method]) {
    pathObj[method]['x-speakeasy-mcp'] = { disabled: true }
  }
}

// Disable any remaining unannotated endpoints (catch-all for future routes)
const annotatedPaths = new Set([
  ...Object.keys(TOOL_ANNOTATIONS),
  ...Object.keys(DISABLED_PATHS),
])
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    if (method === 'parameters') continue
    if (!operation['x-speakeasy-mcp'] && !annotatedPaths.has(path)) {
      operation['x-speakeasy-mcp'] = { disabled: true }
    }
  }
}

// Validate expected tool count
const uniqueTools = new Set(Object.values(TOOL_ANNOTATIONS).map((c) => c.tool['tool-name']))
if (uniqueTools.size !== 9) {
  console.error(`ERROR: Expected 9 unique tools, found ${uniqueTools.size}`)
  process.exit(1)
}

writeFileSync(specPath, JSON.stringify(spec, null, 2))
console.log(`Annotated ${Object.keys(TOOL_ANNOTATIONS).length} endpoints → ${uniqueTools.size} unique tools, disabled remaining endpoints`)
if (warnings > 0) process.exit(1)
```

- [ ] **Step 2: Commit**

```bash
git add scripts/annotate-openapi.ts
git commit -m "feat(scripts): add OpenAPI x-speakeasy-mcp annotation post-processor"
```

---

### Task 13: Speakeasy MCP Server Setup

**Files:**
- Create: `speakeasy.yaml`

- [ ] **Step 1: Create Speakeasy root config**

Create `speakeasy.yaml` at the repo root:

```yaml
configVersion: 2.0.0
generation:
  sdkClassName: LucidOracle
  targetLanguage: typescript
mcpServerOptions:
  serverName: lucid-oracle-mcp
  serverVersion: 1.0.0
```

- [ ] **Step 2: Add openapi.json to .gitignore**

Append to `.gitignore` (if not already present):

```
openapi.json
```

- [ ] **Step 3: Document the generation pipeline in CLAUDE.md**

Append to the `## Commands` section of `CLAUDE.md`:

```markdown
# MCP generation (Plan 3B)
npm run dev                     # Start API server
curl http://localhost:4040/docs/json > openapi.json
npx tsx scripts/annotate-openapi.ts openapi.json
speakeasy validate -s openapi.json
speakeasy generate -s openapi.json -o apps/mcp -t typescript
```

- [ ] **Step 4: Update CLAUDE.md implementation status**

In `CLAUDE.md`, update the Plan 3B row from:

```
| Plan 3B | Planned | MCP tools (5 free + 10+ pro) |
```

To:

```
| Plan 3B | Done (API) | MCP tools — 3 new endpoints + OpenAPI annotations + Speakeasy config (MCP generation pending Task 14) |
```

- [ ] **Step 5: Commit**

```bash
git add speakeasy.yaml .gitignore CLAUDE.md
git commit -m "feat(mcp): add Speakeasy config + generation pipeline docs"
```

---

### Task 14: MCP Server Generation + Smoke Test

> **Note:** This task requires Speakeasy CLI installed (`npm install -g @speakeasy-api/speakeasy`) and the API server running locally. If Speakeasy is not available, this task can be deferred — the API endpoints and annotations are the deliverables; MCP generation is the final assembly step.

- [ ] **Step 1: Start the API server**

Run: `npm run dev` (in a separate terminal)
Wait for: `Oracle Economy API listening on :4040`

- [ ] **Step 2: Export and annotate the OpenAPI spec**

```bash
curl http://localhost:4040/docs/json > openapi.json
npx tsx scripts/annotate-openapi.ts openapi.json
```

Expected: `Annotated 12 endpoints → 9 unique tools, disabled remaining endpoints`

- [ ] **Step 3: Validate the spec**

```bash
speakeasy validate -s openapi.json
```

Expected: Validation passes with no errors

- [ ] **Step 4: Generate the MCP server**

```bash
speakeasy generate -s openapi.json -o apps/mcp -t typescript
```

Expected: `apps/mcp/` directory created with generated MCP server code

- [ ] **Step 5: Verify MCP server lists 9 tools**

```bash
cd apps/mcp && npm install && npx @modelcontextprotocol/inspector
```

Expected: Inspector shows 9 tools matching the tool table in the spec.

- [ ] **Step 6: Commit generated MCP server**

```bash
git add apps/mcp speakeasy.yaml
git commit -m "feat(mcp): generate Speakeasy MCP server with 9 curated tools"
```
