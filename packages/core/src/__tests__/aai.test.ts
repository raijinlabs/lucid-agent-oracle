import { describe, it, expect } from 'vitest'
import { computeAAI, AAI_WEIGHTS, AAI_NORMALIZATION, type AAIInputs } from '../feeds/aai.js'

describe('computeAAI', () => {
  const baseInputs: AAIInputs = {
    active_agents: 50,
    throughput_per_second: 5,
    authentic_tool_call_volume: 5000,
    model_provider_diversity: 25,
    window_seconds: 3600,
  }

  it('returns value in [0, 1000]', () => {
    const result = computeAAI(baseInputs)
    expect(result.value).toBeGreaterThanOrEqual(0)
    expect(result.value).toBeLessThanOrEqual(1000)
  })

  it('uses log10 normalization with anchor constants', () => {
    const result = computeAAI(baseInputs)
    const expectedAgents = Math.min(1000, (Math.log10(51) / Math.log10(101)) * 1000)
    expect(result.breakdown.active_agents).toBeCloseTo(expectedAgents, 1)
  })

  it('returns zero for empty inputs', () => {
    const empty: AAIInputs = {
      active_agents: 0, throughput_per_second: 0,
      authentic_tool_call_volume: 0, model_provider_diversity: 0,
      window_seconds: 3600,
    }
    const result = computeAAI(empty)
    expect(result.value).toBe(0)
    expect(result.breakdown.active_agents).toBe(0)
  })

  it('caps sub-metrics at 1000', () => {
    const high: AAIInputs = {
      active_agents: 1_000_000, throughput_per_second: 1_000_000,
      authentic_tool_call_volume: 1_000_000_000, model_provider_diversity: 1_000_000,
      window_seconds: 3600,
    }
    const result = computeAAI(high)
    expect(result.value).toBe(1000)
    expect(result.breakdown.active_agents).toBe(1000)
  })

  it('produces deterministic provenance hashes', () => {
    const a = computeAAI(baseInputs)
    const b = computeAAI(baseInputs)
    expect(a.input_manifest_hash).toBe(b.input_manifest_hash)
    expect(a.computation_hash).toBe(b.computation_hash)
    expect(a.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('weights sum to 1.0', () => {
    const sum = AAI_WEIGHTS.active_agents + AAI_WEIGHTS.throughput_per_second +
      AAI_WEIGHTS.authentic_tool_call_volume + AAI_WEIGHTS.model_provider_diversity
    expect(sum).toBeCloseTo(1.0, 10)
  })
})
