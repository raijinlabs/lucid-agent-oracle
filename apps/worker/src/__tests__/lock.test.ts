import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
const mockOn = vi.fn()
const mockEnd = vi.fn()
vi.mock('pg', () => ({
  default: { Client: vi.fn(() => ({ connect: vi.fn(), query: mockQuery, on: mockOn, end: mockEnd })) },
}))

import { acquireAdvisoryLock, releaseAdvisoryLock } from '../lock.js'

describe('advisory lock', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('acquires lock and returns true when available', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    const result = await acquireAdvisoryLock('postgresql://test', 1)
    expect(result).not.toBeNull()
    expect(mockQuery).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1)', [1])
  })

  it('returns null when lock is held', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] })
    const result = await acquireAdvisoryLock('postgresql://test', 1)
    expect(result).toBeNull()
  })
})
