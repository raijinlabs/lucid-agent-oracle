import { createHash } from 'node:crypto'
import { canonicalStringify } from '../utils/canonical-json.js'

/** Input data for AEGDP computation — USD values per protocol */
export interface AEGDPInputs {
  protocol_payments_usd: Record<string, number>
  protocol_task_revenue_usd: Record<string, number>
  protocol_revenue_distributed_usd: Record<string, number>
}

/** AEGDP computation result with provenance hashes */
export interface AEGDPResult {
  value_usd: number
  breakdown: {
    total_payments_usd: number
    total_task_revenue_usd: number
    total_revenue_distributed_usd: number
    by_protocol: Record<string, number>
  }
  input_manifest_hash: string
  computation_hash: string
}

/** Deterministic AEGDP computation. Pure function — no side effects. */
export function computeAEGDP(inputs: AEGDPInputs): AEGDPResult {
  const allProtocols = new Set([
    ...Object.keys(inputs.protocol_payments_usd),
    ...Object.keys(inputs.protocol_task_revenue_usd),
    ...Object.keys(inputs.protocol_revenue_distributed_usd),
  ])

  const totalPayments = sumValues(inputs.protocol_payments_usd)
  const totalTaskRevenue = sumValues(inputs.protocol_task_revenue_usd)
  const totalRevenueDistributed = sumValues(inputs.protocol_revenue_distributed_usd)

  const byProtocol: Record<string, number> = {}
  for (const p of allProtocols) {
    byProtocol[p] =
      (inputs.protocol_payments_usd[p] ?? 0) +
      (inputs.protocol_task_revenue_usd[p] ?? 0) +
      (inputs.protocol_revenue_distributed_usd[p] ?? 0)
  }

  const valueUsd = totalPayments + totalTaskRevenue + totalRevenueDistributed

  return {
    value_usd: valueUsd,
    breakdown: {
      total_payments_usd: totalPayments,
      total_task_revenue_usd: totalTaskRevenue,
      total_revenue_distributed_usd: totalRevenueDistributed,
      by_protocol: byProtocol,
    },
    input_manifest_hash: hashInputs(inputs),
    computation_hash: COMPUTATION_HASH,
  }
}

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, v) => sum + v, 0)
}

function hashInputs(inputs: AEGDPInputs): string {
  return createHash('sha256').update(canonicalStringify(inputs)).digest('hex')
}

/** Hash of this computation's source code version */
const COMPUTATION_HASH = createHash('sha256')
  .update('aegdp_v1_sum_payments_tasks_revenue')
  .digest('hex')
