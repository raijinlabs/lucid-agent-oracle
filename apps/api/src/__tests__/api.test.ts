import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { registerOracleRoutes, _resetFeedValues, handleIndexUpdate } from '../routes/v1.js'

describe('Oracle Economy API', () => {
  const app = Fastify()

  beforeAll(async () => {
    registerOracleRoutes(app)
    await app.ready()
  })

  afterAll(async () => {
    _resetFeedValues()
    await app.close()
  })

  it('GET /v1/oracle/feeds returns all V1 feeds', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.feeds).toHaveLength(3)
    expect(body.feeds.map((f: any) => f.id)).toEqual(['aegdp', 'aai', 'apri'])
  })

  it('GET /v1/oracle/feeds/aegdp returns AEGDP definition', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.feed.id).toBe('aegdp')
    expect(body.feed.name).toBe('Agent Economy GDP')
  })

  it('GET /v1/oracle/feeds/nonexistent returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/nonexistent' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /v1/oracle/feeds/aegdp/methodology returns confidence formula', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp/methodology' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence_formula.version).toBe(1)
    expect(body.confidence_formula.weights.source_diversity_score).toBe(0.25)
  })

  it('GET /v1/oracle/protocols returns indexed protocols', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.protocols.length).toBeGreaterThanOrEqual(3)
    expect(body.protocols.find((p: any) => p.id === 'lucid')).toBeTruthy()
  })

  it('GET /v1/oracle/reports/latest returns null when no feeds computed', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/reports/latest' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.report).toBeNull()
  })

  it('GET /v1/oracle/reports/latest returns data after handleIndexUpdate', async () => {
    const msg = JSON.stringify({
      feed_id: 'aegdp',
      feed_version: 1,
      computed_at: '2026-03-12T00:00:00.000Z',
      revision: 0,
      value_json: '{"value_usd":12345.67}',
      value_usd: 12345.67,
      value_index: null,
      confidence: 0.85,
      completeness: 0.9,
      freshness_ms: 5000,
      staleness_risk: 'low',
      revision_status: 'preliminary',
      methodology_version: 1,
      input_manifest_hash: 'abc',
      computation_hash: 'def',
      signer_set_id: 'test-signer',
      signatures_json: '[{"signer":"test-signer","sig":"sig123"}]',
      source_coverage: '["lucid_gateway"]',
      published_solana: null,
      published_base: null,
    })
    handleIndexUpdate(msg)

    const res = await app.inject({ method: 'GET', url: '/v1/oracle/reports/latest' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.report).not.toBeNull()
    expect(body.report.feeds).toHaveLength(1)
    expect(body.report.feeds[0].feed_id).toBe('aegdp')

    // Verify backward-compatible response shape
    const feedRes = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp' })
    const feedBody = feedRes.json()
    expect(feedBody.latest).not.toBeNull()
    expect(feedBody.latest.value).toBe('{"value_usd":12345.67}')
    expect(feedBody.latest.signer).toBe('test-signer')
  })

  it('handleIndexUpdate ignores malformed messages', () => {
    handleIndexUpdate('not json')
    handleIndexUpdate('{}') // missing feed_id — should not crash
  })

  it('GET /v1/oracle/feeds/aai/methodology returns computation details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aai/methodology' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body.computation.type).toBe('activity_index')
    expect(body.computation.weights.active_agents).toBe(0.25)
    expect(body.canonical_json_version).toBe('v1')
  })
})
