import { describe, it, expect } from 'vitest'
import {
  buildAEGDPInputs,
  buildAAIInputs,
  buildAPRIInputs,
} from '../compute.js'
import type { ProtocolUsdRow, WindowAggregates, ProviderCountRow } from '@lucid/oracle-core'

describe('buildAEGDPInputs', () => {
  it('groups USD by protocol and event_type', () => {
    const rows: ProtocolUsdRow[] = [
      { protocol: 'lucid', event_type: 'payment', usd_value: 500 },
      { protocol: 'lucid', event_type: 'task_complete', usd_value: 200 },
      { protocol: 'virtuals', event_type: 'revenue_distribute', usd_value: 100 },
    ]
    const inputs = buildAEGDPInputs(rows)
    expect(inputs.protocol_payments_usd.lucid).toBe(500)
    expect(inputs.protocol_task_revenue_usd.lucid).toBe(200)
    expect(inputs.protocol_revenue_distributed_usd.virtuals).toBe(100)
  })
})

describe('buildAAIInputs', () => {
  it('maps window aggregates to AAI inputs', () => {
    const agg: WindowAggregates = {
      total_events: 1000, total_authentic: 900, total_usd: 50000,
      total_success: 950, total_errors: 50,
      authentic_operational: 800, authentic_tool_calls: 400,
      total_operational: 900, operational_errors: 50,
      unique_agents_authentic: 42, unique_model_provider_pairs_authentic: 15,
      unique_providers: 3,
    }
    const inputs = buildAAIInputs(agg, 3600)
    expect(inputs.active_agents).toBe(42)
    expect(inputs.throughput_per_second).toBeCloseTo(800 / 3600, 4)
    expect(inputs.authentic_tool_call_volume).toBe(400)
    expect(inputs.model_provider_diversity).toBe(15)
  })
})

describe('buildAPRIInputs', () => {
  it('maps aggregates + provider counts to APRI inputs', () => {
    const agg: WindowAggregates = {
      total_events: 1000, total_authentic: 950, total_usd: 50000,
      total_success: 950, total_errors: 50,
      authentic_operational: 800, authentic_tool_calls: 400,
      total_operational: 900, operational_errors: 30,
      unique_agents_authentic: 42, unique_model_provider_pairs_authentic: 15,
      unique_providers: 3,
    }
    const providers: ProviderCountRow[] = [
      { provider: 'openai', cnt: 600 },
      { provider: 'anthropic', cnt: 300 },
    ]
    const inputs = buildAPRIInputs(agg, providers, 55, 60)
    expect(inputs.error_count).toBe(30)
    expect(inputs.operational_event_count).toBe(900)
    expect(inputs.provider_event_counts).toEqual({ openai: 600, anthropic: 300 })
    expect(inputs.active_buckets).toBe(55)
    expect(inputs.total_buckets).toBe(60)
  })
})
