import { describe, it, expect } from 'vitest'
import { computeEventId } from '../types/events.js'

describe('computeEventId', () => {
  it('produces a deterministic UUID from natural key', () => {
    const id1 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_abc')
    const id2 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_abc')
    expect(id1).toBe(id2)
    // UUID format: 8-4-4-4-12
    expect(id1).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  })

  it('produces different IDs for different inputs', () => {
    const id1 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_abc')
    const id2 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_def')
    expect(id1).not.toBe(id2)
  })

  it('uses tx_hash and log_index when available', () => {
    const id1 = computeEventId('virtuals_acp', 'base', '0xabc123', 0)
    const id2 = computeEventId('virtuals_acp', 'base', '0xabc123', 1)
    expect(id1).not.toBe(id2)
  })
})
