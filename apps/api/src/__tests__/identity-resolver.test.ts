import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IdentityResolver } from '../services/identity-resolver.js'
import type { ERC8004Event } from '@lucid/oracle-core'

const mockDb = {
  query: vi.fn(),
}

const mockProducer = {
  publishJson: vi.fn().mockResolvedValue(undefined),
}

function makeResolver() {
  return new IdentityResolver(mockDb as any, mockProducer as any)
}

const baseEvent: ERC8004Event = {
  event_id: 'test-uuid',
  event_type: 'agent_registered',
  source: 'erc8004',
  chain: 'base',
  block_number: 100,
  tx_hash: '0xabc',
  log_index: 0,
  timestamp: new Date('2026-03-12T00:00:00Z'),
  agent_id: '0x0001',
  owner_address: '0xOwner',
  tba_address: '0xTBA',
  reputation_score: null,
  validator_address: null,
  evidence_hash: null,
  raw_data: '{}',
}

describe('IdentityResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates agent_entity for new AgentRegistered', async () => {
    const resolver = makeResolver()
    // No existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT agent_entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_test123' }] })
    // INSERT wallet_mapping for TBA
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT wallet_mapping for owner
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT identity_link
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(baseEvent)

    // Check agent_entity was created
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_entities'),
      expect.any(Array),
    )
    // Check watchlist update published
    expect(mockProducer.publishJson).toHaveBeenCalledWith(
      'wallet_watchlist.updated',
      expect.any(String),
      expect.objectContaining({ action: 'add', chain: 'base' }),
    )
  })

  it('skips TBA mapping when tba_address is null', async () => {
    const resolver = makeResolver()
    const event = { ...baseEvent, tba_address: null }
    // No existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT agent_entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_test456' }] })
    // INSERT wallet_mapping for owner only
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT identity_link
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    // Only 4 queries: check existing, insert entity, insert owner mapping, insert link
    expect(mockDb.query).toHaveBeenCalledTimes(4)
  })

  it('updates reputation for ReputationUpdated', async () => {
    const resolver = makeResolver()
    const event: ERC8004Event = {
      ...baseEvent,
      event_type: 'reputation_updated',
      reputation_score: 8500,
      validator_address: '0xValidator',
      evidence_hash: '0xEvidence',
    }
    // Find existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    // UPDATE reputation
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE agent_entities'),
      expect.arrayContaining([expect.stringContaining('"score":8500')]),
    )
  })

  it('logs warning when ReputationUpdated for unknown agent', async () => {
    const resolver = makeResolver()
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event: ERC8004Event = { ...baseEvent, event_type: 'reputation_updated', reputation_score: 9000 }
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('unknown agent'))
    consoleSpy.mockRestore()
  })

  it('soft-deletes old owner for OwnershipTransferred', async () => {
    const resolver = makeResolver()
    const event: ERC8004Event = {
      ...baseEvent,
      event_type: 'ownership_transferred',
      owner_address: '0xNewOwner',
    }
    const rawData = JSON.parse(event.raw_data)
    event.raw_data = JSON.stringify({ ...rawData, old_owner: '0xOldOwner' })

    // Find existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    // Soft-delete old owner mapping
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT new owner mapping
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('removed_at'),
      expect.any(Array),
    )
  })
})
