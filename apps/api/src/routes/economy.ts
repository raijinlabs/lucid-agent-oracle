import type { FastifyInstance } from 'fastify'
import type { DbClient } from '@lucid/oracle-core'
import { Type } from '@sinclair/typebox'
import { sendProblem } from '../schemas/common.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const EconomySnapshotSchema = Type.Object({
  snapshot_at: Type.String(),
  total_agents: Type.Integer(),
  active_agents_24h: Type.Integer(),
  total_wallets: Type.Integer(),
  total_tvl_usd: Type.Number(),
  tx_volume_24h_usd: Type.Number(),
  tx_count_24h: Type.Integer(),
  new_agents_7d: Type.Integer(),
  avg_reputation_score: Type.Union([Type.Number(), Type.Null()]),
  top_tokens_json: Type.Unknown(),
})

const CurrentResponse = Type.Object({
  data: EconomySnapshotSchema,
})

const HistoryQuery = Type.Object({
  period: Type.Optional(
    Type.Union([
      Type.Literal('1d'),
      Type.Literal('7d'),
      Type.Literal('30d'),
    ], { default: '7d' }),
  ),
})

const HistoryResponse = Type.Object({
  data: Type.Array(EconomySnapshotSchema),
})

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerEconomyRoutes(
  app: FastifyInstance,
  db: DbClient,
): void {

  // ---- GET /v1/oracle/economy/current ----
  app.get('/v1/oracle/economy/current', {
    schema: {
      tags: ['agents'],
      summary: 'Current economy snapshot',
      description: 'Latest economy-wide metrics snapshot.',
      response: {
        200: CurrentResponse,
        404: { $ref: 'ProblemDetail' },
      },
    },
    config: {
      rateLimit: { max: 60 },
    },
  }, async (_request, reply) => {
    const { rows } = await db.query(
      `SELECT snapshot_at, total_agents, active_agents_24h, total_wallets,
              total_tvl_usd, tx_volume_24h_usd, tx_count_24h, new_agents_7d,
              avg_reputation_score, top_tokens_json
       FROM oracle_economy_snapshots
       ORDER BY snapshot_at DESC
       LIMIT 1`,
    )

    if (rows.length === 0) {
      return sendProblem(reply, 404, {
        type: 'no-snapshots',
        title: 'No Snapshots',
        detail: 'No economy snapshots have been computed yet.',
        code: 'NO_SNAPSHOTS',
      })
    }

    const row = rows[0]
    return reply.send({
      data: {
        snapshot_at: String(row.snapshot_at),
        total_agents: Number(row.total_agents),
        active_agents_24h: Number(row.active_agents_24h),
        total_wallets: Number(row.total_wallets),
        total_tvl_usd: Number(row.total_tvl_usd),
        tx_volume_24h_usd: Number(row.tx_volume_24h_usd),
        tx_count_24h: Number(row.tx_count_24h),
        new_agents_7d: Number(row.new_agents_7d),
        avg_reputation_score: row.avg_reputation_score != null ? Number(row.avg_reputation_score) : null,
        top_tokens_json: row.top_tokens_json ?? [],
      },
    })
  })

  // ---- GET /v1/oracle/economy/history ----
  app.get('/v1/oracle/economy/history', {
    schema: {
      tags: ['agents'],
      summary: 'Economy snapshot history',
      description: 'Time series of economy snapshots over a given period.',
      querystring: HistoryQuery,
      response: {
        200: HistoryResponse,
      },
    },
    config: {
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const query = request.query as { period?: string }
    const period = query.period ?? '7d'

    const intervalMap: Record<string, string> = {
      '1d': '1 day',
      '7d': '7 days',
      '30d': '30 days',
    }
    const interval = intervalMap[period] ?? '7 days'

    const { rows } = await db.query(
      `SELECT snapshot_at, total_agents, active_agents_24h, total_wallets,
              total_tvl_usd, tx_volume_24h_usd, tx_count_24h, new_agents_7d,
              avg_reputation_score, top_tokens_json
       FROM oracle_economy_snapshots
       WHERE snapshot_at > now() - $1::text::interval
       ORDER BY snapshot_at ASC`,
      [interval],
    )

    const data = rows.map((row) => ({
      snapshot_at: String(row.snapshot_at),
      total_agents: Number(row.total_agents),
      active_agents_24h: Number(row.active_agents_24h),
      total_wallets: Number(row.total_wallets),
      total_tvl_usd: Number(row.total_tvl_usd),
      tx_volume_24h_usd: Number(row.tx_volume_24h_usd),
      tx_count_24h: Number(row.tx_count_24h),
      new_agents_7d: Number(row.new_agents_7d),
      avg_reputation_score: row.avg_reputation_score != null ? Number(row.avg_reputation_score) : null,
      top_tokens_json: row.top_tokens_json ?? [],
    }))

    return reply.send({ data })
  })
}
