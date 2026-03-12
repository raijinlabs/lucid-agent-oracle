import type { FastifyInstance } from 'fastify'
import {
  V1_FEEDS, CONFIDENCE_WEIGHTS,
  OracleClickHouse,
  type FeedId, type PublishedFeedRow,
} from '@lucid/oracle-core'

// In-memory cache (replaced from Map<string, PublishedFeedValue> to Map<string, PublishedFeedRow>)
const latestFeedValues = new Map<string, PublishedFeedRow>()

/** Map internal PublishedFeedRow to the public API response shape.
 *  MUST preserve backward compatibility with Plan 1's PublishedFeedValue format. */
function toPublicFeedValue(row: PublishedFeedRow): {
  feed_id: string; value: string; confidence: number; completeness: number;
  freshness_ms: number; staleness_risk: string; computed_at: string;
  signer: string; signature: string;
} {
  const sigs = JSON.parse(row.signatures_json) as Array<{ signer: string; sig: string }>
  return {
    feed_id: row.feed_id,
    value: row.value_json,
    confidence: row.confidence,
    completeness: row.completeness,
    freshness_ms: row.freshness_ms,
    staleness_risk: row.staleness_risk,
    computed_at: row.computed_at,
    signer: sigs[0]?.signer ?? row.signer_set_id,
    signature: sigs[0]?.sig ?? '',
  }
}

// Internal only — no longer exported
function updateFeedValue(feedId: string, row: PublishedFeedRow): void {
  const existing = latestFeedValues.get(feedId)
  // Only update if newer
  if (!existing || row.computed_at > existing.computed_at) {
    latestFeedValues.set(feedId, row)
  }
}

/** Backfill cache from ClickHouse on startup. */
export async function initFeedCache(clickhouse: OracleClickHouse): Promise<void> {
  for (const def of Object.values(V1_FEEDS)) {
    const row = await clickhouse.queryLatestPublishedValue(def.id, def.version)
    if (row) {
      latestFeedValues.set(def.id, row)
    }
  }
}

/** Handle INDEX_UPDATES message from Redpanda consumer. */
export function handleIndexUpdate(messageValue: string): void {
  try {
    const row = JSON.parse(messageValue) as PublishedFeedRow
    if (!row.feed_id || !row.computed_at) {
      console.warn('Ignoring INDEX_UPDATES message: missing feed_id or computed_at')
      return
    }
    updateFeedValue(row.feed_id, row)
  } catch {
    console.error('Failed to parse INDEX_UPDATES message')
  }
}

/** Reconcile cache against ClickHouse (closes startup race window). */
export async function reconcileFeedCache(clickhouse: OracleClickHouse): Promise<void> {
  for (const def of Object.values(V1_FEEDS)) {
    const row = await clickhouse.queryLatestPublishedValue(def.id, def.version)
    if (row) {
      updateFeedValue(def.id, row)
    }
  }
}

export function registerOracleRoutes(app: FastifyInstance): void {
  // ---- GET /v1/oracle/feeds ----
  app.get('/v1/oracle/feeds', async () => {
    return {
      feeds: Object.values(V1_FEEDS).map((f) => ({
        ...f,
        latest_value: (() => { const r = latestFeedValues.get(f.id); return r ? toPublicFeedValue(r) : null })(),
      })),
    }
  })

  // ---- GET /v1/oracle/feeds/:id ----
  app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id', async (request, reply) => {
    const { id } = request.params
    const def = V1_FEEDS[id as FeedId]
    if (!def) {
      return reply.status(404).send({ error: 'Feed not found', feed_id: id })
    }

    const row = latestFeedValues.get(id)
    return {
      feed: def,
      latest: row ? toPublicFeedValue(row) : null,
      methodology_url: def.methodology_url,
    }
  })

  // ---- GET /v1/oracle/feeds/:id/methodology ----
  app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id/methodology', async (request, reply) => {
    const { id } = request.params
    const def = V1_FEEDS[id as FeedId]
    if (!def) {
      return reply.status(404).send({ error: 'Feed not found', feed_id: id })
    }

    const base = {
      feed_id: id,
      version: def.version,
      name: def.name,
      description: def.description,
      update_interval_ms: def.update_interval_ms,
      deviation_threshold_bps: def.deviation_threshold_bps,
      confidence_formula: {
        version: CONFIDENCE_WEIGHTS.version,
        weights: { ...CONFIDENCE_WEIGHTS },
      },
    }

    // Feed-specific computation details
    if (id === 'aai') {
      return {
        ...base,
        computation: {
          type: 'activity_index',
          range: [0, 1000],
          normalization: 'log10',
          weights: { active_agents: 0.25, throughput_per_second: 0.25, authentic_tool_call_volume: 0.25, model_provider_diversity: 0.25 },
          anchors: { active_agents: 100, throughput_per_second: 10, authentic_tool_call_volume: 10000, model_provider_diversity: 50 },
          formula: 'min(1000, log10(value+1) / log10(anchor+1) * 1000)',
        },
        canonical_json_version: 'v1',
      }
    }

    if (id === 'apri') {
      return {
        ...base,
        computation: {
          type: 'risk_index',
          range_bps: [0, 10000],
          scaling: 'raw_fraction * 10000',
          weights: { error_rate: 0.30, provider_concentration: 0.25, authenticity_ratio: 0.25, activity_continuity: 0.20 },
          dimensions: {
            error_rate: { scope: 'llm_inference + tool_call' },
            provider_concentration: { method: 'HHI', scope: 'provider IS NOT NULL' },
            authenticity_ratio: { scope: 'all events' },
            activity_continuity: { scope: 'all events', bucket_size_ms: 60000 },
          },
        },
        canonical_json_version: 'v1',
      }
    }

    // AEGDP (default)
    return {
      ...base,
      computation: {
        type: 'economic_gdp',
        unit: 'USD',
        components: ['protocol_payments_usd', 'protocol_task_revenue_usd', 'protocol_revenue_distributed_usd'],
        formula: 'sum(all_protocol_values_across_components)',
      },
      canonical_json_version: 'v1',
    }
  })

  // ---- GET /v1/oracle/protocols ----
  app.get('/v1/oracle/protocols', async () => {
    return {
      protocols: [
        { id: 'lucid', name: 'Lucid', chains: ['offchain', 'base', 'solana'], status: 'active' },
        { id: 'virtuals', name: 'Virtuals Protocol', chains: ['base'], status: 'pending' },
        { id: 'olas', name: 'Olas / Autonolas', chains: ['gnosis', 'base', 'optimism'], status: 'pending' },
      ],
    }
  })

  // ---- GET /v1/oracle/reports/latest ----
  app.get('/v1/oracle/reports/latest', async () => {
    const feedValues = Array.from(latestFeedValues.entries()).map(([, r]) => toPublicFeedValue(r))
    return {
      report: feedValues.length > 0 ? { feeds: feedValues } : null,
    }
  })
}

/** Test reset */
export function _resetFeedValues(): void {
  latestFeedValues.clear()
}
