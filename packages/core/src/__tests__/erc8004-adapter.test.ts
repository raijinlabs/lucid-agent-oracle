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
    // getOrCreateEntity: INSERT returns the new row
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_new123' }] })
    const event = {
      event_type: 'agent_registered',
      agent_id: '42',
      owner_address: '0xOwner',
      agent_uri: 'https://example.com/agent.json',
      tx_hash: '0xabc',
      block_number: 100,
    }

    await handler.handleEvent(event, db, null)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_agent_entities'),
      expect.arrayContaining([expect.stringContaining('ae_'), '42']),
    )
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_agent_entities SET agent_uri'),
      expect.arrayContaining(['https://example.com/agent.json']),
    )
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0xOwner', 'onchain_proof']),
    )
  })

  it('handles uri_updated by updating agent_uri', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    await handler.handleEvent({
      event_type: 'uri_updated',
      agent_id: '42',
      agent_uri: 'https://new-uri.com/agent.json',
      owner_address: '0xOwner',
    }, db, null)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_agent_entities SET agent_uri'),
      expect.arrayContaining(['https://new-uri.com/agent.json', 'ae_existing']),
    )
  })

  it('handles metadata_set with agentWallet — decodes address and creates wallet mapping', async () => {
    const db = mockDb()
    // handleMetadataSet does SELECT to find entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    await handler.handleEvent({
      event_type: 'metadata_set',
      agent_id: '42',
      key_hash: '0x2ac6109326e720d1',
      value: 'agentWallet',
      data: '0x00000000000000000000000067722c823010ceb4bed5325fe109196c0f67d053',
    }, db, null)

    // Should create wallet mapping from decoded address
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0x67722c823010ceb4bed5325fe109196c0f67d053', 'onchain_proof']),
    )
    // Should store in metadata_json with JS-built JSON string
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('metadata_json'),
      expect.arrayContaining([expect.stringContaining('agentWallet')]),
    )
  })

  it('handles metadata_set with ecosystem — stores decoded string', async () => {
    const db = mockDb()
    // handleMetadataSet does SELECT to find entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    await handler.handleEvent({
      event_type: 'metadata_set',
      agent_id: '42',
      value: 'ecosystem',
      data: '0x4f6c617300000000000000000000000000000000000000000000000000000000',
    }, db, null)

    // metadata_json now receives a JS-built JSON string containing both key and value
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('metadata_json'),
      expect.arrayContaining([JSON.stringify({ ecosystem: 'Olas' })]),
    )
  })

  it('handles ownership_transferred with old owner soft-delete', async () => {
    const db = mockDb()
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })

    await handler.handleEvent({
      event_type: 'ownership_transferred',
      agent_id: '42',
      previous_owner: '0xOldOwner',
      new_owner: '0xNewOwner',
      tx_hash: '0xdef',
    }, db, null)

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_wallet_mappings SET removed_at'),
      expect.arrayContaining(['0xOldOwner']),
    )
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oracle_wallet_mappings'),
      expect.arrayContaining(['0xNewOwner', 'onchain_proof']),
    )
  })
})
