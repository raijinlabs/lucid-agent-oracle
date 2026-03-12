import { createHash } from 'node:crypto'
import { canonicalStringify } from '../utils/canonical-json.js'

export const APRI_WEIGHTS = {
  version: 1,
  error_rate: 0.30,
  provider_concentration: 0.25,
  authenticity_ratio: 0.25,
  activity_continuity: 0.20,
} as const

export interface APRIInputs {
  error_count: number
  operational_event_count: number
  provider_event_counts: Record<string, number>
  authentic_event_count: number
  total_event_count: number
  active_buckets: number
  total_buckets: number
}

export interface APRIResult {
  value: number
  breakdown: {
    error_rate: number
    provider_concentration: number
    authenticity_ratio: number
    activity_continuity: number
  }
  input_manifest_hash: string
  computation_hash: string
}

/** Hash of this computation's source code version */
const COMPUTATION_HASH = createHash('sha256')
  .update(`apri_v${APRI_WEIGHTS.version}_hhi_error_auth_continuity`)
  .digest('hex')

function computeHHI(providerCounts: Record<string, number>): number {
  const total = Object.values(providerCounts).reduce((sum, c) => sum + c, 0)
  if (total === 0) return 0
  return Object.values(providerCounts).reduce((hhi, count) => {
    const share = count / total
    return hhi + share * share
  }, 0)
}

/** Deterministic APRI computation. Pure function — no side effects. */
export function computeAPRI(inputs: APRIInputs): APRIResult {
  const errorRateRaw = inputs.operational_event_count > 0
    ? inputs.error_count / inputs.operational_event_count : 0
  const providerConcentrationRaw = computeHHI(inputs.provider_event_counts)
  const authenticityRatioRaw = inputs.total_event_count > 0
    ? 1 - (inputs.authentic_event_count / inputs.total_event_count) : 0
  const activityContinuityRaw = inputs.total_buckets > 0
    ? 1 - (inputs.active_buckets / inputs.total_buckets) : 0

  const breakdown = {
    error_rate: errorRateRaw * 10000,
    provider_concentration: providerConcentrationRaw * 10000,
    authenticity_ratio: authenticityRatioRaw * 10000,
    activity_continuity: activityContinuityRaw * 10000,
  }

  const value =
    APRI_WEIGHTS.error_rate * breakdown.error_rate +
    APRI_WEIGHTS.provider_concentration * breakdown.provider_concentration +
    APRI_WEIGHTS.authenticity_ratio * breakdown.authenticity_ratio +
    APRI_WEIGHTS.activity_continuity * breakdown.activity_continuity

  const input_manifest_hash = createHash('sha256')
    .update(canonicalStringify(inputs))
    .digest('hex')

  return { value, breakdown, input_manifest_hash, computation_hash: COMPUTATION_HASH }
}
