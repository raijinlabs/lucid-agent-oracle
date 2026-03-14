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
