import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { registerProtocolRoutes } from '../routes/protocols.js'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

describe('Protocol routes', () => {
  const db = mockDb()
  const app = Fastify()

  beforeAll(async () => {
    registerProtocolRoutes(app, db)
    await app.ready()
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => { db.query.mockReset().mockResolvedValue({ rows: [] }) })

  // GET /v1/oracle/protocols/:id
  it('returns 404 for unknown protocol', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols/unknown' })
    expect(res.statusCode).toBe(404)
  })

  it('returns protocol detail with stats', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 42 }] }) // agent count
    db.query.mockResolvedValueOnce({ rows: [{ cnt: 85 }] }) // wallet count
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols/lucid' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.protocol.name).toBe('Lucid')
    expect(body.protocol.agent_count).toBe(42)
  })

  // GET /v1/oracle/protocols/:id/metrics (Pro)
  it('metrics returns 403 for free tier', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols/lucid/metrics' })
    expect(res.statusCode).toBe(403)
  })

  it('metrics returns data for pro tier', async () => {
    // 8 parallel queries
    for (let i = 0; i < 8; i++) {
      db.query.mockResolvedValueOnce({ rows: [{ cnt: i + 1 }] })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/protocols/lucid/metrics',
      headers: { 'x-api-tier': 'pro' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().agents).toBeDefined()
  })

  it('metrics returns 404 for unknown protocol', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/oracle/protocols/unknown/metrics',
      headers: { 'x-api-tier': 'pro' },
    })
    expect(res.statusCode).toBe(404)
  })
})
