/**
 * Integration test: ERC-8004 → staging table → resolver → identity tables.
 *
 * Verifies the data shape transformation across all stages of the no-broker pipeline.
 * Does NOT require a real database — uses mocks to verify the correct SQL and payload shapes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processAdapterEvents } from '../adapters/resolver-poller.js'

// Mock the full pipeline: staging row → dispatch → identity handler
const mockClient = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
  release: vi.fn(),
}

const mockPool = {
  connect: vi.fn().mockResolvedValue(mockClient),
}

describe('ERC-8004 full pipeline: staging → resolver → identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockReset()
  })

  it('resolver merges payload_json with row metadata for dispatch', async () => {
    const dispatchSpy = vi.fn().mockResolvedValue(undefined)

    // Simulate a staging table row as pg returns it
    const stagingRow = {
      id: 1,
      event_id: 'erc8004_base_0xabc_0',
      source: 'erc8004',
      source_adapter_ver: 1,
      chain: 'base',
      event_type: 'agent_registered',
      event_timestamp: '2026-03-19T00:00:00Z',
      payload_json: { agent_id: '0x1234', owner_address: '0xowner', tba_address: null },
      block_number: 20000001,
      tx_hash: '0xabc',
      log_index: 0,
      error_count: 0,
    }

    // BEGIN
    mockClient.query.mockResolvedValueOnce({ rows: [] })
    // SELECT (return staging row)
    mockClient.query.mockResolvedValueOnce({ rows: [stagingRow] })
    // UPDATE processed_at
    mockClient.query.mockResolvedValueOnce({ rows: [] })
    // COMMIT
    mockClient.query.mockResolvedValueOnce({ rows: [] })

    await processAdapterEvents(mockPool as any, dispatchSpy, 10)

    expect(dispatchSpy).toHaveBeenCalledOnce()
    const [source, event, client] = dispatchSpy.mock.calls[0]

    // Source is correct
    expect(source).toBe('erc8004')

    // Event has both payload fields AND metadata fields
    expect(event.agent_id).toBe('0x1234')           // from payload_json
    expect(event.owner_address).toBe('0xowner')      // from payload_json
    expect(event.event_type).toBe('agent_registered') // from row metadata
    expect(event.tx_hash).toBe('0xabc')               // from row metadata
    expect(event.block_number).toBe(20000001)          // from row metadata
    expect(event.chain).toBe('base')                   // from row metadata
    expect(event.source).toBe('erc8004')               // from row metadata
  })

  it('handles string payload_json (not pre-parsed)', async () => {
    const dispatchSpy = vi.fn().mockResolvedValue(undefined)

    const stagingRow = {
      id: 2,
      event_id: 'erc8004_base_0xdef_1',
      source: 'erc8004',
      chain: 'base',
      event_type: 'ownership_transferred',
      event_timestamp: '2026-03-19T01:00:00Z',
      payload_json: '{"agent_id":"0x5678","new_owner":"0xnew","previous_owner":"0xold"}',
      block_number: 20000002,
      tx_hash: '0xdef',
      log_index: 1,
      error_count: 0,
    }

    mockClient.query.mockResolvedValueOnce({ rows: [] }) // BEGIN
    mockClient.query.mockResolvedValueOnce({ rows: [stagingRow] }) // SELECT
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // UPDATE
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // COMMIT

    await processAdapterEvents(mockPool as any, dispatchSpy, 10)

    const [, event] = dispatchSpy.mock.calls[0]
    expect(event.agent_id).toBe('0x5678')
    expect(event.event_type).toBe('ownership_transferred')
    expect(event.new_owner).toBe('0xnew')
  })

  it('Ponder event shape matches what the resolver expects', () => {
    // This test documents the contract between Ponder handlers and the resolver.
    // Ponder writes: { event_id, source, chain, event_type, event_timestamp, payload_json, block_number, tx_hash, log_index }
    // Resolver merges: payload_json fields + { event_type, event_id, source, chain, block_number, tx_hash, log_index, timestamp }
    // Handler expects: event.event_type, event.agent_id, event.owner_address, event.tx_hash, etc.

    const ponderEvent = {
      event_id: 'erc8004_base_0xabc_0',
      source: 'erc8004',
      source_adapter_ver: 1,
      chain: 'base',
      event_type: 'agent_registered',
      event_timestamp: '2026-03-19T00:00:00Z',
      payload_json: JSON.stringify({
        agent_id: '0x1234abcd',
        owner_address: '0xowner',
        tba_address: null,
      }),
      block_number: 20000001,
      tx_hash: '0xabc',
      log_index: 0,
    }

    // Simulate what the resolver does
    const parsed = JSON.parse(ponderEvent.payload_json)
    const mergedEvent = {
      ...parsed,
      event_type: ponderEvent.event_type,
      event_id: ponderEvent.event_id,
      source: ponderEvent.source,
      chain: ponderEvent.chain,
      block_number: ponderEvent.block_number,
      tx_hash: ponderEvent.tx_hash,
      log_index: ponderEvent.log_index,
      timestamp: ponderEvent.event_timestamp,
    }

    // Verify the handler will find what it needs
    expect(mergedEvent.event_type).toBe('agent_registered')
    expect(mergedEvent.agent_id).toBe('0x1234abcd')
    expect(mergedEvent.owner_address).toBe('0xowner')
    expect(mergedEvent.tx_hash).toBe('0xabc')
    expect(mergedEvent.block_number).toBe(20000001)
    expect(mergedEvent.chain).toBe('base')
  })
})
