import { describe, it, expect, vi, beforeEach } from 'vitest'
import { erc8004Adapter } from '../adapters/erc8004-adapter.js'

function mockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

describe('erc8004Adapter identity handler', () => {
  const handler = erc8004Adapter.identity!

  it('creates entity and wallet mappings for agent_registered', async () => {
    const db = mockDb()
    const event = {
      event_type: 'agent_registered',
      agent_id: '42',
      owner_address: '0xOwner',
      agent_uri: 'https://example.com/agent.json',
      tx_hash: '0xabc',
      block_number: 100,
    }

    await handler.handleEvent(event, db, null)

    // Should create entity
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_agent_entities'),
      expect.arrayContaining([expect.stringContaining('ae_'), '42']),
    )
    // Should update agent_uri
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_agent_entities SET agent_uri'),
      expect.arrayContaining(['https://example.com/agent.json']),
    )
    // Should create owner wallet mapping
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0xOwner', 'erc8004_owner']),
    )
  })

  it('handles uri_updated by updating agent_uri', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    const event = {
      event_type: 'uri_updated',
      agent_id: '42',
      agent_uri: 'https://new-uri.com/agent.json',
      owner_address: '0xOwner',
    }

    await handler.handleEvent(event, db, null)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_agent_entities SET agent_uri'),
      expect.arrayContaining(['https://new-uri.com/agent.json', 'ae_existing']),
    )
  })

  it('handles metadata_set by accumulating JSONB', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    const event = {
      event_type: 'metadata_set',
      agent_id: '42',
      key_hash: '0xabcdef',
      value: 'some-value',
    }

    await handler.handleEvent(event, db, null)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('metadata_json'),
      expect.arrayContaining(['0xabcdef', 'some-value', 'ae_existing']),
    )
  })

  it('handles ownership_transferred with old owner soft-delete', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    const event = {
      event_type: 'ownership_transferred',
      agent_id: '42',
      previous_owner: '0xOldOwner',
      new_owner: '0xNewOwner',
      tx_hash: '0xdef',
    }

    await handler.handleEvent(event, db, null)

    // Should soft-delete old owner mapping
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_wallet_mappings SET removed_at'),
      expect.arrayContaining(['0xOldOwner']),
    )
    // Should upsert new owner wallet mapping
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0xNewOwner', 'erc8004_owner']),
    )
  })
})
