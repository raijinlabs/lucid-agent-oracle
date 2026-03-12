import type {
  AEGDPInputs,
  AAIInputs,
  APRIInputs,
  ProtocolUsdRow,
  WindowAggregates,
  ProviderCountRow,
} from '@lucid/oracle-core'

/** Map per-protocol per-event-type USD rows to AEGDP inputs. */
export function buildAEGDPInputs(rows: ProtocolUsdRow[]): AEGDPInputs {
  const payments: Record<string, number> = {}
  const tasks: Record<string, number> = {}
  const revenue: Record<string, number> = {}

  for (const r of rows) {
    switch (r.event_type) {
      case 'payment':
        payments[r.protocol] = (payments[r.protocol] ?? 0) + r.usd_value
        break
      case 'task_complete':
        tasks[r.protocol] = (tasks[r.protocol] ?? 0) + r.usd_value
        break
      case 'revenue_distribute':
        revenue[r.protocol] = (revenue[r.protocol] ?? 0) + r.usd_value
        break
    }
  }

  return {
    protocol_payments_usd: payments,
    protocol_task_revenue_usd: tasks,
    protocol_revenue_distributed_usd: revenue,
  }
}

/** Map window aggregates to AAI inputs. */
export function buildAAIInputs(agg: WindowAggregates, windowSeconds: number): AAIInputs {
  return {
    active_agents: agg.unique_agents_authentic,
    throughput_per_second: windowSeconds > 0 ? agg.authentic_operational / windowSeconds : 0,
    authentic_tool_call_volume: agg.authentic_tool_calls,
    model_provider_diversity: agg.unique_model_provider_pairs_authentic,
    window_seconds: windowSeconds,
  }
}

/** Map aggregates + raw provider counts to APRI inputs. */
export function buildAPRIInputs(
  agg: WindowAggregates,
  providerCounts: ProviderCountRow[],
  activeBuckets: number,
  totalBuckets: number,
): APRIInputs {
  const providerEventCounts: Record<string, number> = {}
  for (const r of providerCounts) {
    providerEventCounts[r.provider] = r.cnt
  }

  return {
    error_count: agg.operational_errors,
    operational_event_count: agg.total_operational,
    provider_event_counts: providerEventCounts,
    authentic_event_count: agg.total_authentic,
    total_event_count: agg.total_events,
    active_buckets: activeBuckets,
    total_buckets: totalBuckets,
  }
}
