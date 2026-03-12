import type { FastifyInstance } from 'fastify'
import { V1_FEEDS, CONFIDENCE_WEIGHTS, type FeedId, type PublishedFeedValue } from '@lucid/oracle-core'

// In-memory store for MVP (replaced by ClickHouse in production)
const latestFeedValues = new Map<string, PublishedFeedValue>()

export function registerOracleRoutes(app: FastifyInstance): void {
  // ---- GET /v1/oracle/feeds ----
  app.get('/v1/oracle/feeds', async () => {
    return {
      feeds: Object.values(V1_FEEDS).map((f) => ({
        ...f,
        latest_value: latestFeedValues.get(f.id) ?? null,
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

    const latest = latestFeedValues.get(id)
    return {
      feed: def,
      latest: latest ?? null,
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

    return {
      feed_id: id,
      version: def.version,
      name: def.name,
      description: def.description,
      update_interval_ms: def.update_interval_ms,
      deviation_threshold_bps: def.deviation_threshold_bps,
      confidence_formula: {
        version: CONFIDENCE_WEIGHTS.version,
        weights: {
          source_diversity_score: CONFIDENCE_WEIGHTS.source_diversity_score,
          identity_confidence: CONFIDENCE_WEIGHTS.identity_confidence,
          data_completeness: CONFIDENCE_WEIGHTS.data_completeness,
          anomaly_cleanliness: CONFIDENCE_WEIGHTS.anomaly_cleanliness,
          freshness_score: CONFIDENCE_WEIGHTS.freshness_score,
          revision_stability: CONFIDENCE_WEIGHTS.revision_stability,
        },
        note: 'All inputs normalized to [0,1] where higher = more confident',
      },
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
    const feedValues = Array.from(latestFeedValues.entries()).map(([id, v]) => ({
      ...v,
      feed_id: id,
    }))
    return {
      report: feedValues.length > 0 ? { feeds: feedValues } : null,
    }
  })
}

/** Used by feed computation worker to push new values */
export function updateFeedValue(feedId: string, value: PublishedFeedValue): void {
  latestFeedValues.set(feedId, value)
}

/** Test reset */
export function _resetFeedValues(): void {
  latestFeedValues.clear()
}
