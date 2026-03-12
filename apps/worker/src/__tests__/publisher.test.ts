import { describe, it, expect } from 'vitest'
import { shouldPublish, type PublishContext } from '../publisher.js'

describe('shouldPublish', () => {
  const base: PublishContext = {
    feedId: 'aegdp',
    newValue: 1000,
    previousValue: 990,
    thresholdBps: 100,
    lastPublishedAt: null,
    heartbeatIntervalMs: 900_000,
    now: Date.now(),
  }

  it('publishes on first computation (no previous)', () => {
    expect(shouldPublish({ ...base, previousValue: null, lastPublishedAt: null })).toBe(true)
  })

  it('publishes when deviation exceeds threshold', () => {
    // |1000 - 990| / max(990, 1) * 10000 = 101 bps > 100 bps
    expect(shouldPublish(base)).toBe(true)
  })

  it('does not publish when deviation is below threshold', () => {
    const recent = Date.now() - 60_000 // 1 min ago — within heartbeat window
    expect(shouldPublish({ ...base, newValue: 990.5, lastPublishedAt: recent })).toBe(false)
  })

  it('publishes on heartbeat even without deviation', () => {
    const old = Date.now() - 1_000_000 // > 15 min ago
    expect(shouldPublish({ ...base, newValue: 990, lastPublishedAt: old })).toBe(true)
  })
})
