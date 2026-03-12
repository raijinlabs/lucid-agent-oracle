import { describe, it, expect } from 'vitest'
import { computeAEGDP, type AEGDPInputs } from '../feeds/aegdp.js'

describe('computeAEGDP', () => {
  it('sums payment values across protocols', () => {
    const inputs: AEGDPInputs = {
      protocol_payments_usd: { lucid: 100_000, virtuals: 500_000, olas: 200_000 },
      protocol_task_revenue_usd: { lucid: 50_000, virtuals: 80_000, olas: 20_000 },
      protocol_revenue_distributed_usd: { lucid: 10_000, virtuals: 40_000, olas: 10_000 },
    }
    const result = computeAEGDP(inputs)

    expect(result.value_usd).toBe(1_010_000)
    expect(result.breakdown.total_payments_usd).toBe(800_000)
    expect(result.breakdown.total_task_revenue_usd).toBe(150_000)
    expect(result.breakdown.total_revenue_distributed_usd).toBe(60_000)
  })

  it('returns zero for empty inputs', () => {
    const inputs: AEGDPInputs = {
      protocol_payments_usd: {},
      protocol_task_revenue_usd: {},
      protocol_revenue_distributed_usd: {},
    }
    const result = computeAEGDP(inputs)
    expect(result.value_usd).toBe(0)
  })

  it('includes per-protocol breakdown', () => {
    const inputs: AEGDPInputs = {
      protocol_payments_usd: { lucid: 100 },
      protocol_task_revenue_usd: { lucid: 50 },
      protocol_revenue_distributed_usd: { lucid: 10 },
    }
    const result = computeAEGDP(inputs)
    expect(result.breakdown.by_protocol.lucid).toBe(160)
  })
})
