import { describe, it, expect, vi, beforeEach } from 'vitest'
import { erc8004Adapter } from '../adapters/erc8004-adapter.js'
import type { ERC8004Event } from '../types/identity.js'

function mockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

function mockProducer() {
  return {
    publishJson: vi.fn().mockResolvedValue(undefined),
    publishEvents: vi.fn().mockResolvedValue(undefined),
  } as any
}

function makeEvent(overrides: Partial<ERC8004Event> = {}): ERC8004Event {
  return {
    event_id: 'test-id',
    event_type: 'agent_registered',
    source: 'erc8004',
    chain: 'base',
    block_number: 100,
    tx_hash: '0xabc',
    log_index: 0,
    timestamp: new Date('2026-01-01'),
    agent_id: 'agent-1',
    owner_address: '0xOwner',
    tba_address: '0xTBA',
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: '{}',
    ...overrides,
  }
}

describe('erc8004Adapter identity handler', () => {
  const handler = erc8004Adapter.identity!

  it('creates entity and wallet mappings for agent_registered', async () => {
    const db = mockDb()
    const producer = mockProducer()
    const event = makeEvent()

    await handler.handleEvent(event as any, db, producer)

    // Should create entity
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_agent_entities'),
      expect.arrayContaining([expect.stringContaining('ae_'), 'agent-1']),
    )
    // Should create TBA wallet mapping
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0xTBA', 'erc8004_tba']),
    )
    // Should create owner wallet mapping
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0xOwner', 'erc8004_owner']),
    )
    // Should publish watchlist updates
    expect(producer.publishJson).toHaveBeenCalledTimes(2)
  })

  it('handles agent_updated by updating display name', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    const producer = mockProducer()

    const event = makeEvent({
      event_type: 'agent_updated',
      raw_data: JSON.stringify({ name: 'Updated Agent' }),
    })

    await handler.handleEvent(event as any, db, producer)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_agent_entities SET display_name'),
      expect.arrayContaining(['Updated Agent', 'ae_existing']),
    )
  })

  it('updates reputation for reputation_updated', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    const producer = mockProducer()

    const event = makeEvent({
      event_type: 'reputation_updated',
      reputation_score: 8500,
      validator_address: '0xValidator',
      evidence_hash: '0xEvidence',
    })

    await handler.handleEvent(event as any, db, producer)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_agent_entities SET reputation_json'),
      expect.arrayContaining([expect.stringContaining('"score":8500'), 'ae_existing']),
    )
  })

  it('handles ownership_transferred with old owner soft-delete', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    const producer = mockProducer()

    const event = makeEvent({
      event_type: 'ownership_transferred',
      owner_address: '0xNewOwner',
      raw_data: JSON.stringify({ old_owner: '0xOldOwner' }),
    })

    await handler.handleEvent(event as any, db, producer)

    // Should soft-delete old owner mapping
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_wallet_mappings SET removed_at'),
      expect.arrayContaining(['0xOldOwner']),
    )
    // Should publish remove + add watchlist updates
    expect(producer.publishJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('0xOldOwner'),
      expect.objectContaining({ action: 'remove' }),
    )
    expect(producer.publishJson).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('0xNewOwner'),
      expect.objectContaining({ action: 'add' }),
    )
  })
})
