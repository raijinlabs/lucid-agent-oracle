import { createHash } from 'node:crypto'
import { canonicalStringify } from '../utils/canonical-json.js'

export const AAI_WEIGHTS = {
  version: 1,
  active_agents: 0.25,
  throughput_per_second: 0.25,
  authentic_tool_call_volume: 0.25,
  model_provider_diversity: 0.25,
} as const

export const AAI_NORMALIZATION = {
  version: 1,
  active_agents: 100,
  throughput_per_second: 10,
  authentic_tool_call_volume: 10_000,
  model_provider_diversity: 50,
} as const

export interface AAIInputs {
  active_agents: number
  throughput_per_second: number
  authentic_tool_call_volume: number
  model_provider_diversity: number
  window_seconds: number
}

export interface AAIResult {
  value: number
  breakdown: {
    active_agents: number
    throughput_per_second: number
    authentic_tool_call_volume: number
    model_provider_diversity: number
  }
  input_manifest_hash: string
  computation_hash: string
}

/** Hash of this computation's source code version */
const COMPUTATION_HASH = createHash('sha256')
  .update(`aai_v${AAI_WEIGHTS.version}_log10_norm_weighted`)
  .digest('hex')

function normalize(value: number, anchor: number): number {
  if (value <= 0) return 0
  return Math.min(1000, (Math.log10(value + 1) / Math.log10(anchor + 1)) * 1000)
}

/** Deterministic AAI computation. Pure function — no side effects. */
export function computeAAI(inputs: AAIInputs): AAIResult {
  const breakdown = {
    active_agents: normalize(inputs.active_agents, AAI_NORMALIZATION.active_agents),
    throughput_per_second: normalize(inputs.throughput_per_second, AAI_NORMALIZATION.throughput_per_second),
    authentic_tool_call_volume: normalize(inputs.authentic_tool_call_volume, AAI_NORMALIZATION.authentic_tool_call_volume),
    model_provider_diversity: normalize(inputs.model_provider_diversity, AAI_NORMALIZATION.model_provider_diversity),
  }

  const value =
    AAI_WEIGHTS.active_agents * breakdown.active_agents +
    AAI_WEIGHTS.throughput_per_second * breakdown.throughput_per_second +
    AAI_WEIGHTS.authentic_tool_call_volume * breakdown.authentic_tool_call_volume +
    AAI_WEIGHTS.model_provider_diversity * breakdown.model_provider_diversity

  const input_manifest_hash = createHash('sha256')
    .update(canonicalStringify(inputs))
    .digest('hex')

  return { value, breakdown, input_manifest_hash, computation_hash: COMPUTATION_HASH }
}
