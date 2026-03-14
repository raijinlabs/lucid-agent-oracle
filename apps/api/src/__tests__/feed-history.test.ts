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
