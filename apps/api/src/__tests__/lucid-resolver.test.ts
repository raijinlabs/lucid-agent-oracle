import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LucidResolver } from '../services/lucid-resolver.js'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

describe('LucidResolver', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>
  let resolver: LucidResolver

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    resolver = new LucidResolver(db, producer)
    vi.clearAllMocks()
  })

  it('skips if advisory lock not acquired', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] })

    const result = await resolver.run()
    expect(result.skipped).toBe(true)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('creates new entity for tenant with no existing entity or wallet match', async () => {
    // 1. Advisory lock acquired
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query gateway_tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-1',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'base', address: '0xWALLET1' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check agent_entities for lucid_tenant
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Check wallet_mappings for any matching wallet
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Create entity
    db.query.mockResolvedValueOnce({ rows: [] })
    // 7. Insert evidence (RETURNING id)
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] })
    // 8. Check wallet mapping exists
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. Insert wallet mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. Upsert identity_link
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 12. Release advisory lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.skipped).toBe(false)
    expect(result.processed).toBe(1)
    expect(result.created).toBe(1)
  })

  it('enriches ERC-8004 entity with lucid_tenant (cross-source merge)', async () => {
    // 1. Advisory lock
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-2',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'base', address: '0xERC8004WALLET' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check lucid_tenant — not found
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Check wallet — mapped to ERC-8004 entity!
    db.query.mockResolvedValueOnce({ rows: [{ agent_entity: 'ae_erc8004' }] })
    // 6. Enrich entity (SET lucid_tenant)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_erc8004' }] })
    // 7. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 2 }] })
    // 8. Wallet already mapped to same entity — skip
    db.query.mockResolvedValueOnce({ rows: [{ agent_entity: 'ae_erc8004' }] })
    // 9. Upsert identity_link
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. Release lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.enriched).toBe(1)
  })

  it('creates conflict when wallet mapped to different entity', async () => {
    // 1. Advisory lock
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-3',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'base', address: '0xCONFLICT' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check lucid_tenant — not found
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Check wallet — not mapped (for entity lookup)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Create entity
    db.query.mockResolvedValueOnce({ rows: [] })
    // 7. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 3 }] })
    // 8. Check wallet mapping — mapped to DIFFERENT entity!
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_other', confidence: 0.9 }],
    })
    // 9. Insert conflict
    db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] })
    // 10. Upsert identity_link
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 12. Release lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.conflicts).toBe(1)
  })

  it('is idempotent — existing entity reused', async () => {
    // 1. Advisory lock
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-4',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'solana', address: 'SOL111' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check lucid_tenant — FOUND existing entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    // 5. Insert evidence (dedup — ON CONFLICT DO NOTHING, no id returned)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Fallback SELECT for evidence id
    db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] })
    // 7. Check wallet mapping — already mapped to same entity
    db.query.mockResolvedValueOnce({ rows: [{ agent_entity: 'ae_existing' }] })
    // 8. Upsert identity_link (ON CONFLICT DO NOTHING)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. Release lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.processed).toBe(1)
    expect(result.created).toBe(0)
    expect(result.enriched).toBe(0)
  })
})
