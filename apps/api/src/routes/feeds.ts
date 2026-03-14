import type { FastifyInstance } from 'fastify'
import type { OracleClickHouse } from '@lucid/oracle-core'
import { V1_FEEDS, type FeedId } from '@lucid/oracle-core'
import { sendProblem } from '../schemas/common.js'
import { FeedIdParams, FeedHistoryQuery, FeedHistoryResponse } from '../schemas/feeds.js'
import { keys } from '../services/redis.js'

/** Periods that require pro tier or higher. */
const PRO_PERIODS = new Set(['30d', '90d'])

export function registerFeedRoutes(
  app: FastifyInstance,
  clickhouse: OracleClickHouse | null,
): void {

  // ---- GET /v1/oracle/feeds/:id/history ----
  app.get<{ Params: { id: string }; Querystring: { period?: string; interval?: string } }>(
    '/v1/oracle/feeds/:id/history',
    {
      schema: {
        tags: ['feeds'],
        summary: 'Get feed history',
        description: 'Time-series feed values from ClickHouse. Free tier limited to 7d. Pro/Growth up to 90d.',
        params: FeedIdParams,
        querystring: FeedHistoryQuery,
        response: {
          200: FeedHistoryResponse,
          403: { $ref: 'ProblemDetail' },
          404: { $ref: 'ProblemDetail' },
        },
      },
      config: {
        cache: {
          ttl: 60,
          key: (request: { params: Record<string, string>; query: Record<string, string>; tenant?: { plan: string } }) => {
            const period = request.query.period ?? '7d'
            const interval = request.query.interval ?? '1h'
            const plan = request.tenant?.plan ?? 'free'
            return keys.feedHistory(request.params.id, period, interval, plan)
          },
        },
        rateLimit: { max: 30 },
      },
    },
    async (request, reply) => {
      const { id } = request.params
      const period = request.query.period ?? '7d'
      const interval = request.query.interval ?? '1h'

      // Validate feed exists
      const feedDef = V1_FEEDS[id as FeedId]
      if (!feedDef) {
        return sendProblem(reply, 404, {
          type: 'not-found',
          title: 'Feed Not Found',
          detail: `No feed found with id '${id}'.`,
          code: 'FEED_NOT_FOUND',
        })
      }

      // Tier gate: 30d/90d require pro
      if (PRO_PERIODS.has(period)) {
        const plan = request.tenant?.plan ?? 'free'
        if (plan === 'free') {
          return sendProblem(reply, 403, {
            type: 'tier-required',
            title: 'Insufficient Plan Tier',
            detail: `Period '${period}' requires plan 'pro' or higher. Your current plan is 'free'.`,
            code: 'TIER_REQUIRED',
          })
        }
      }

      // ClickHouse not available → empty data
      if (!clickhouse) {
        return reply.send({
          data: {
            feed_id: id,
            period,
            interval,
            has_data: false,
            points: [],
          },
        })
      }

      const points = await clickhouse.queryFeedHistory(id, feedDef.version, period, interval)

      return reply.send({
        data: {
          feed_id: id,
          period,
          interval,
          has_data: points.length > 0,
          points,
        },
      })
    },
  )
}
