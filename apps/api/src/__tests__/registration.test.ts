import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RegistrationHandler } from '../services/registration-handler.js'
import { VerifierRegistry } from '@lucid/oracle-core'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

/** Creates a mock VerifierRegistry where all chains verify successfully */
function mockVerifiers(result = true) {
  const reg = new VerifierRegistry()
  reg.register({ chains: ['base', 'ethereum'], verify: async () => result })
  reg.register({ chains: ['solana'], verify: async () => result })
  return reg
}

describe('RegistrationHandler', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>
  let handler: RegistrationHandler

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    handler = new RegistrationHandler(db, producer, mockVerifiers())
    vi.clearAllMocks()
  })

  it('rejects expired challenge', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test', environment: 'production',
        expires_at: new Date(Date.now() - 60_000),
        consumed_at: null,
      }],
    })

    const result = await handler.register('n1', '0xsig')
    expect(result.error).toContain('expired')
    expect(result.status).toBe(410)
  })

  it('rejects consumed challenge', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: new Date(),
      }],
    })

    const result = await handler.register('n1', '0xsig')
    expect(result.error).toContain('consumed')
    expect(result.status).toBe(410)
  })

  it('rejects missing challenge', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    const result = await handler.register('missing', '0xsig')
    expect(result.status).toBe(404)
  })

  it('creates new entity + mapping + evidence on success (new entity flow)', async () => {
    // 1. Challenge lookup
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Check existing entity by wallet — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Create entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_new123' }] })
    // 5. Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] })
    // 7. Check existing mapping — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 8. Insert mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. Fetch wallets for response
    db.query.mockResolvedValueOnce({ rows: [{ chain: 'base', address: '0xABC' }] })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(200)
    expect(result.data?.agent_entity_id).toBe('ae_new123')
  })

  it('detects conflict when wallet mapped to different entity', async () => {
    // 1. Challenge lookup
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Check existing entity by wallet — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Create entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_claiming' }] })
    // 5. Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] })
    // 7. Check existing mapping — mapped to different entity!
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_existing', confidence: 0.8 }],
    })
    // 8. Insert conflict
    db.query.mockResolvedValueOnce({ rows: [{ id: 42 }] })
    // 9. Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT (entity + evidence + conflict persisted, no mapping)
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(409)
    expect(result.data?.conflict_id).toBe(42)
  })

  it('rejects target_entity registration when auth mapping revoked (race guard)', async () => {
    // 1. Challenge lookup — has target_entity + auth
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xNEW',
        target_entity: 'ae_target', auth_chain: 'base', auth_address: '0xAUTH',
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Re-validate auth mapping — REVOKED (empty result)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. ROLLBACK
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(403)
    expect(result.error).toContain('Authorization expired')
  })

  it('rejects invalid signature', async () => {
    const rejectHandler = new RegistrationHandler(db, producer, mockVerifiers(false))

    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })

    const result = await rejectHandler.register('n1', '0xsig')
    expect(result.status).toBe(401)
  })

  it('attaches wallet to existing entity when target_entity set', async () => {
    // 1. Challenge lookup — target_entity set
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xNEW',
        target_entity: 'ae_target', auth_chain: 'base', auth_address: '0xAUTH',
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Re-validate auth mapping — still active
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_target' }],
    })
    // 4. Auth evidence insert
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] })
    // 7. Check existing mapping — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 8. Insert mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. Fetch wallets for response
    db.query.mockResolvedValueOnce({
      rows: [
        { chain: 'base', address: '0xAUTH' },
        { chain: 'base', address: '0xNEW' },
      ],
    })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(200)
    expect(result.data?.agent_entity_id).toBe('ae_target')
  })
})
