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
