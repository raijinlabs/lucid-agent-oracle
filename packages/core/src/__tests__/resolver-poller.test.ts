import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processAdapterEvents } from '../adapters/resolver-poller.js'

const mockClient = {
  query: vi.fn().mockResolvedValue({ rows: [] }),
  release: vi.fn(),
}

const mockPool = {
  connect: vi.fn().mockResolvedValue(mockClient),
}

const mockDispatch = vi.fn().mockResolvedValue(undefined)

describe('processAdapterEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockReset()
    mockClient.query.mockResolvedValue({ rows: [] })
  })

  it('processes unprocessed events and marks them done', async () => {
    // BEGIN
    mockClient.query.mockResolvedValueOnce({ rows: [] })
    // SELECT (return one event)
    mockClient.query.mockResolvedValueOnce({
      rows: [{
        id: 1,
        event_id: 'test_1',
        source: 'erc8004',
        chain: 'base',
        event_type: 'agent_registered',
        event_timestamp: '2026-03-19T00:00:00Z',
        payload_json: { agent_id: '0x123' },
        block_number: 20000001,
        tx_hash: '0xabc',
        log_index: 0,
        error_count: 0,
      }],
    })
    // dispatch call happens via mockDispatch
    // UPDATE processed_at
    mockClient.query.mockResolvedValueOnce({ rows: [] })
    // COMMIT
    mockClient.query.mockResolvedValueOnce({ rows: [] })

    const n = await processAdapterEvents(mockPool as any, mockDispatch, 10)
    expect(n).toBe(1)
    // Dispatch receives merged event: payload fields + row metadata
    expect(mockDispatch).toHaveBeenCalledWith(
      'erc8004',
      expect.objectContaining({ agent_id: '0x123', event_type: 'agent_registered', chain: 'base' }),
      mockClient,
    )
  })

  it('returns 0 when no events pending', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // BEGIN
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // SELECT empty
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // COMMIT

    const n = await processAdapterEvents(mockPool as any, mockDispatch, 10)
    expect(n).toBe(0)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('increments error_count on dispatch failure', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // BEGIN
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 1, source: 'helius', payload_json: {}, error_count: 0 }],
    })
    mockDispatch.mockRejectedValueOnce(new Error('resolver failed'))
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // UPDATE error
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // COMMIT

    const n = await processAdapterEvents(mockPool as any, mockDispatch, 10)
    expect(n).toBe(0) // not processed successfully

    // Check the error update query
    const errorCall = mockClient.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('error_count'),
    )
    expect(errorCall).toBeDefined()
    expect(errorCall![1][0]).toBe(1) // error_count = 1
    expect(errorCall![1][1]).toBe('resolver failed') // last_error
  })

  it('sets failed_at after MAX_ERROR_COUNT failures', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // BEGIN
    mockClient.query.mockResolvedValueOnce({
      rows: [{ id: 1, source: 'erc8004', payload_json: {}, error_count: 4 }],
    })
    mockDispatch.mockRejectedValueOnce(new Error('still failing'))
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // UPDATE with failed_at
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // COMMIT

    await processAdapterEvents(mockPool as any, mockDispatch, 10)

    const errorCall = mockClient.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('SET error_count') && c[0].includes('failed_at'),
    )
    expect(errorCall).toBeDefined()
    expect(errorCall![0]).toContain('failed_at = now()')
  })

  it('rolls back on unexpected error', async () => {
    mockClient.query.mockResolvedValueOnce({ rows: [] }) // BEGIN
    mockClient.query.mockRejectedValueOnce(new Error('connection lost')) // SELECT fails

    await expect(processAdapterEvents(mockPool as any, mockDispatch, 10)).rejects.toThrow('connection lost')

    const rollbackCall = mockClient.query.mock.calls.find(
      (c: any) => c[0] === 'ROLLBACK',
    )
    expect(rollbackCall).toBeDefined()
    expect(mockClient.release).toHaveBeenCalled()
  })
})
