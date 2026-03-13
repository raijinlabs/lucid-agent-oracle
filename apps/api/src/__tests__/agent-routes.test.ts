import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { registerAgentRoutes } from '../routes/agents.js'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

describe('Agent routes', () => {
  const db = mockDb()
  const app = Fastify()

  beforeAll(async () => {
    registerAgentRoutes(app, db)
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { db.query.mockReset().mockResolvedValue({ rows: [] }) })

  // GET /v1/oracle/agents/search
  it('search returns 400 when no params given', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search' })
    expect(res.statusCode).toBe(400)
  })

  it('search returns 400 when only chain param given (chain alone is not a valid search)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search?chain=base' })
    expect(res.statusCode).toBe(400)
  })

  it('search returns results for wallet param', async () => {
    // count query returns 1
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 1 }] })
    // data query
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', display_name: 'A', erc8004_id: null, created_at: '2026-03-12' }] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/search?wallet=0xABC' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agents).toHaveLength(1)
    expect(body.total).toBe(1)
  })

  // GET /v1/oracle/agents/leaderboard
  it('leaderboard returns ranked agents', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 1 }] })
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', display_name: 'Top', erc8004_id: null, created_at: '2026-03-12', wallet_count: 5, protocol_count: 3, evidence_count: 10 }] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/leaderboard' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agents).toHaveLength(1)
    expect(body.sort).toBe('wallet_count')
  })

  // GET /v1/oracle/agents/:id
  it('profile returns 404 for unknown agent', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_nonexistent' })
    expect(res.statusCode).toBe(404)
  })

  it('profile returns agent data', async () => {
    // Entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', display_name: 'Agent', erc8004_id: null, lucid_tenant: null, reputation_json: null, reputation_updated_at: null, created_at: '2026-03-12', updated_at: '2026-03-12' }] })
    // Wallets
    db.query.mockResolvedValueOnce({ rows: [] })
    // Links
    db.query.mockResolvedValueOnce({ rows: [] })
    // Evidence count
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.agent.id).toBe('ae_1')
  })

  // GET /v1/oracle/agents/:id/metrics (Pro)
  it('metrics returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1/metrics' })
    expect(res.statusCode).toBe(403)
  })

  it('metrics returns data for pro tier', async () => {
    // Entity check
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_1', created_at: '2026-03-12', updated_at: '2026-03-12' }] })
    // 9 parallel queries - mock all with simple values
    for (let i = 0; i < 9; i++) {
      db.query.mockResolvedValueOnce({ rows: i === 5 ? [{ protocol: 'lucid' }] : [{ cnt: 0 }] })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/ae_1/metrics',
      headers: { 'x-api-tier': 'pro' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().wallets).toBeDefined()
  })

  // GET /v1/oracle/agents/:id/activity (Pro)
  it('activity returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/agents/ae_1/activity' })
    expect(res.statusCode).toBe(403)
  })

  it('activity returns 404 for unknown agent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/agents/ae_nonexistent/activity',
      headers: { 'x-api-tier': 'pro' },
    })
    expect(res.statusCode).toBe(404)
  })
})
