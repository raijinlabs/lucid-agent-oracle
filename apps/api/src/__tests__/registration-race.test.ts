import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RegistrationHandler } from '../services/registration-handler.js'
import { VerifierRegistry } from '@lucid/oracle-core'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

function mockVerifiers() {
  const reg = new VerifierRegistry()
  reg.register({ chains: ['base', 'ethereum'], verify: async () => true })
  reg.register({ chains: ['solana'], verify: async () => true })
  return reg
}

describe('Registration race conditions', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>
  let handler: RegistrationHandler

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    handler = new RegistrationHandler(db, producer, mockVerifiers())
    vi.clearAllMocks()
  })

  it('concurrent nonce consumption — second attempt rejected as consumed', async () => {
    // Second attempt sees consumed_at set
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-nonce', chain: 'base', address: '0xRACE',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: new Date(),
      }],
    })

    const result = await handler.register('race-nonce', '0xsig')
    expect(result.status).toBe(410)
    expect(result.error).toContain('consumed')
  })

  it('auth mapping revoked between challenge and registration', async () => {
    // Challenge has target_entity + auth
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-auth', chain: 'base', address: '0xNEW',
        target_entity: 'ae_target', auth_chain: 'base', auth_address: '0xAUTH',
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // Auth mapping check — REVOKED (empty)
    db.query.mockResolvedValueOnce({ rows: [] })
    // ROLLBACK
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('race-auth', '0xsig')
    expect(result.status).toBe(403)
    expect(result.error).toContain('Authorization expired')
  })

  it('wallet mapped by another registration between evidence and mapping insert', async () => {
    // New entity flow where wallet gets claimed between steps
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-wallet', chain: 'base', address: '0xCLAIMED',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // Check existing entity — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // Create entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_late' }] })
    // Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 50 }] })
    // Check mapping — NOW mapped to different entity (concurrent registration won)
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_winner', confidence: 1.0 }],
    })
    // Insert conflict
    db.query.mockResolvedValueOnce({ rows: [{ id: 77 }] })
    // Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // COMMIT (entity + evidence + conflict persisted)
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('race-wallet', '0xsig')
    expect(result.status).toBe(409)
  })

  it('challenge expires between issuance and registration', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-expire', chain: 'base', address: '0xLATE',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() - 1), // just expired
        consumed_at: null,
      }],
    })

    const result = await handler.register('race-expire', '0xsig')
    expect(result.status).toBe(410)
    expect(result.error).toContain('expired')
  })
})
