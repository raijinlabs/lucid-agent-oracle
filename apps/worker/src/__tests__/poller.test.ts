import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => ({ query: mockQuery })) },
}))

import { pollGatewayTable } from '../poller.js'

describe('pollGatewayTable', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('queries with compound watermark', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const mockPool = { query: mockQuery } as unknown as import('pg').Pool
    await pollGatewayTable(mockPool, {
      source_table: 'receipt_events',
      watermark_column: 'created_at',
      last_seen_ts: '2026-01-01T00:00:00Z',
      last_seen_id: '',
    })
    const sql = mockQuery.mock.calls[0][0]
    expect(sql).toContain('receipt_events')
    expect(sql).toContain('created_at')
    expect(sql).toContain('ORDER BY')
  })
})
