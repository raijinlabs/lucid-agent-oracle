import { describe, it, expect } from 'vitest'
import { getBackoffMs, MAX_ATTEMPTS } from '../retry.js'

describe('Retry backoff', () => {
  it('attempt 1 → 1000ms', () => {
    expect(getBackoffMs(1)).toBe(1000)
  })

  it('attempt 2 → 2000ms', () => {
    expect(getBackoffMs(2)).toBe(2000)
  })

  it('attempt 3 → 4000ms', () => {
    expect(getBackoffMs(3)).toBe(4000)
  })

  it('attempt 4 → 8000ms', () => {
    expect(getBackoffMs(4)).toBe(8000)
  })

  it('attempt 5 → 16000ms', () => {
    expect(getBackoffMs(5)).toBe(16000)
  })

  it('MAX_ATTEMPTS is 5', () => {
    expect(MAX_ATTEMPTS).toBe(5)
  })
})
