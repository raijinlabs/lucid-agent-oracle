import { describe, it, expect } from 'vitest'
import { computeAPRI, APRI_WEIGHTS, type APRIInputs } from '../feeds/apri.js'

describe('computeAPRI', () => {
  const baseInputs: APRIInputs = {
    error_count: 10,
    operational_event_count: 1000,
    provider_event_counts: { openai: 600, anthropic: 300, google: 100 },
    authentic_event_count: 950,
    total_event_count: 1000,
    active_buckets: 55,
    total_buckets: 60,
  }

  it('returns value in [0, 10000] basis points', () => {
    const result = computeAPRI(baseInputs)
    expect(result.value).toBeGreaterThanOrEqual(0)
    expect(result.value).toBeLessThanOrEqual(10000)
  })

  it('scales raw fractions to basis points', () => {
    const result = computeAPRI(baseInputs)
    expect(result.breakdown.error_rate).toBeCloseTo(100, 0)
  })

  it('computes HHI correctly for provider concentration', () => {
    const result = computeAPRI(baseInputs)
    expect(result.breakdown.provider_concentration).toBeCloseTo(4600, 0)
  })

  it('HHI uses provider-attributed denominator, not operational_event_count', () => {
    const inputs: APRIInputs = {
      ...baseInputs,
      provider_event_counts: { openai: 400, anthropic: 100 },
      operational_event_count: 1000,
    }
    const result = computeAPRI(inputs)
    expect(result.breakdown.provider_concentration).toBeCloseTo(6800, 0)
  })

  it('returns zero risk for zero events (except activity_continuity)', () => {
    const empty: APRIInputs = {
      error_count: 0, operational_event_count: 0,
      provider_event_counts: {},
      authentic_event_count: 0, total_event_count: 0,
      active_buckets: 0, total_buckets: 60,
    }
    const result = computeAPRI(empty)
    expect(result.breakdown.error_rate).toBe(0)
    expect(result.breakdown.provider_concentration).toBe(0)
    expect(result.breakdown.authenticity_ratio).toBe(0)
    expect(result.breakdown.activity_continuity).toBe(10000)
    expect(result.value).toBeCloseTo(2000, 0)
  })

  it('returns maximum risk for worst-case inputs', () => {
    const worst: APRIInputs = {
      error_count: 100, operational_event_count: 100,
      provider_event_counts: { single: 100 },
      authentic_event_count: 0, total_event_count: 100,
      active_buckets: 0, total_buckets: 60,
    }
    const result = computeAPRI(worst)
    expect(result.value).toBeCloseTo(10000, 0)
  })

  it('produces deterministic provenance hashes', () => {
    const a = computeAPRI(baseInputs)
    const b = computeAPRI(baseInputs)
    expect(a.input_manifest_hash).toBe(b.input_manifest_hash)
    expect(a.computation_hash).toBe(b.computation_hash)
    expect(a.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('weights sum to 1.0', () => {
    const sum = APRI_WEIGHTS.error_rate + APRI_WEIGHTS.provider_concentration +
      APRI_WEIGHTS.authenticity_ratio + APRI_WEIGHTS.activity_continuity
    expect(sum).toBeCloseTo(1.0, 10)
  })
})
