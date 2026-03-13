process.env.CURSOR_SECRET = 'test-cursor-secret-32chars-long!'

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { registerAgentRoutes } from '../routes/agents.js'
import { ProblemDetail } from '../schemas/common.js'

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

// ---------------------------------------------------------------------------
// Mock auth plugin — resolves tenant from x-api-key header
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
// Test suite
// ---------------------------------------------------------------------------

describe('Agent routes', () => {
  const db = mockDb()
  const app = Fastify()

  beforeAll(async () => {
    // Register ProblemDetail schema so $ref works
    app.addSchema(ProblemDetail)
    await app.register(mockAuthPlugin)
    registerAgentRoutes(app, db as any)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    db.query.mockReset().mockResolvedValue({ rows: [] })
  })

  // ---- 1. search returns 400 when no params (RFC 9457 shape) ----
  it('search returns 400 when no params given', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.type).toContain('missing-search-param')
    expect(body.status).toBe(400)
  })

  // ---- 2. search returns paginated results for wallet param ----
  it('search returns paginated results for wallet param', async () => {
    // Data query returns 1 result (no has_more since not limit+1)
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'ae_1', display_name: 'Agent A', erc8004_id: null, created_at: '2026-03-12' }],
    })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search?wallet=0xABC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].id).toBe('ae_1')
    expect(body.pagination).toBeDefined()
    expect(body.pagination.has_more).toBe(false)
    expect(body.pagination.limit).toBe(20)
  })

  // ---- 3. leaderboard returns paginated ranked agents ----
  it('leaderboard returns paginated ranked agents', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'ae_1', display_name: 'Top', erc8004_id: null,
        wallet_count: 5, protocol_count: 3, evidence_count: 10, created_at: '2026-03-12',
      }],
    })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/leaderboard' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toHaveLength(1)
    expect(body.data[0].wallet_count).toBe(5)
    expect(body.pagination).toBeDefined()
    expect(body.pagination.has_more).toBe(false)
  })

  // ---- 4. profile returns 404 with Problem Details ----
  it('profile returns 404 with Problem Details', async () => {
    // No entity found → getProfile returns null
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_nonexistent' })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.type).toContain('agent-not-found')
    expect(body.status).toBe(404)
  })

  // ---- 5. profile returns agent data in { data } envelope ----
  it('profile returns agent data in { data } envelope', async () => {
    // Entity
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'ae_1', display_name: 'Agent', erc8004_id: null,
        lucid_tenant: null, reputation_json: null, reputation_updated_at: null,
        created_at: '2026-03-12', updated_at: '2026-03-12',
      }],
    })
    // Wallets
    db.query.mockResolvedValueOnce({ rows: [] })
    // Identity links
    db.query.mockResolvedValueOnce({ rows: [] })
    // Evidence count
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] })

    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toBeDefined()
    expect(body.data.id).toBe('ae_1')
    expect(body.data.protocols).toBeDefined()
    expect(body.data.stats).toBeDefined()
    expect(body.data.stats.wallet_count).toBe(0)
  })

  // ---- 6. metrics returns 403 for free tier (Problem Details) ----
  it('metrics returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1/metrics' })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.type).toContain('tier-required')
    expect(body.status).toBe(403)
  })

  // ---- 7. metrics returns data for pro tier ----
  it('metrics returns data for pro tier', async () => {
    // Entity check
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', created_at: '2026-03-12', updated_at: '2026-03-12' }] })
    // 9 parallel queries — mock all with simple values
    for (let i = 0; i < 9; i++) {
      db.query.mockResolvedValueOnce({ rows: i === 5 ? [{ protocol: 'lucid' }] : [{ cnt: 0 }] })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/ae_1/metrics',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.data).toBeDefined()
    expect(body.data.wallets).toBeDefined()
    expect(body.data.agent_id).toBe('ae_1')
  })

  // ---- 8. activity returns 403 for free tier ----
  it('activity returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1/activity' })
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.type).toContain('tier-required')
    expect(body.status).toBe(403)
  })

  // ---- 9. activity returns 404 for unknown agent (pro tier) ----
  it('activity returns 404 for unknown agent (pro tier)', async () => {
    // exists() returns no rows
    db.query.mockResolvedValueOnce({ rows: [] })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/ae_nonexistent/activity',
      headers: { 'x-api-key': 'pro-key' },
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.type).toContain('agent-not-found')
    expect(body.status).toBe(404)
  })

  // ---- 10. rejects invalid agent ID format (param validation 400) ----
  it('rejects invalid agent ID format', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/INVALID' })
    expect(res.statusCode).toBe(400)
  })
})
