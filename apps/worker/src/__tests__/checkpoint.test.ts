import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => ({ query: mockQuery })) },
}))

import { CheckpointManager } from '../checkpoint.js'

describe('CheckpointManager', () => {
  let mgr: CheckpointManager

  beforeEach(() => {
    vi.clearAllMocks()
    mgr = new CheckpointManager('postgresql://test')
  })

  it('loads checkpoints from database', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { source_table: 'receipt_events', watermark_column: 'created_at', last_seen_ts: '2026-01-01T00:00:00Z', last_seen_id: 'abc' },
      ],
    })
    const checkpoints = await mgr.loadAll()
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].source_table).toBe('receipt_events')
  })

  it('advances checkpoint after successful insert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await mgr.advance('receipt_events', new Date('2026-03-12T12:00:00Z'), 'id_123')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_worker_checkpoints'),
      expect.arrayContaining(['receipt_events'])
    )
  })
})
