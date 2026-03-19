import type { FastifyInstance } from 'fastify'
import type { DbClient, OracleClickHouse } from '@lucid/oracle-core'
import { AgentQueryService } from '../services/agent-query.js'
import {
  AgentSearchQuery,
  AgentSearchResponse,
  LeaderboardQuery,
  LeaderboardResponse,
  AgentProfileResponse,
  AgentMetricsResponse,
  ActivityQuery,
  ActivityResponse,
  ModelUsageQuery,
  ModelUsageResponse,
} from '../schemas/agents.js'
import {
  AgentIdParams,
  ProblemDetail,
  sendProblem,
} from '../schemas/common.js'
import { requireTier } from '../plugins/auth.js'
import { encodeCursor, decodeCursor } from '../utils/cursor.js'
import { keys } from '../services/redis.js'

export function registerAgentRoutes(
  app: FastifyInstance,
  db: DbClient,
  clickhouse?: OracleClickHouse | null,
): void {
  const service = new AgentQueryService(db)

  // ---- GET /v1/oracle/agents/search (Free) ----
  // MUST be registered before /:id to avoid "search" matching as :id param
  app.get('/v1/oracle/agents/search', {
    schema: {
      tags: ['agents'],
      summary: 'Search agents',
      description: 'Search for agent entities by wallet, protocol, ERC-8004 ID, or free-text query.',
      querystring: AgentSearchQuery,
      response: {
        200: AgentSearchResponse,
        400: { $ref: 'ProblemDetail' },
      },
    },
    config: {
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const query = request.query as {
      wallet?: string
      chain?: string
      protocol?: string
      protocol_id?: string
      erc8004_id?: string
      q?: string
      limit?: number
      cursor?: string
    }

    const { wallet, chain, protocol, protocol_id, erc8004_id, q, sort } = query as any

    // At least one search param required
    if (!wallet && !protocol && !protocol_id && !erc8004_id && !q) {
      return sendProblem(reply, 400, {
        type: 'missing-search-param',
        title: 'Missing Search Parameter',
        detail: 'At least one search parameter required (wallet, protocol, protocol_id, erc8004_id, q).',
        code: 'MISSING_SEARCH_PARAM',
      })
    }

    const limit = query.limit ?? 20

    // Decode cursor if present
    let cursorValue: string | undefined
    let cursorId: string | undefined
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (decoded) {
        cursorValue = String(decoded.s)
        cursorId = decoded.id
      }
    }

    const result = await service.search({
      wallet, chain, protocol, protocol_id, erc8004_id, q,
      sort: sort ?? 'newest',
      limit,
      offset: 0,
      cursorValue,
      cursorId,
    })

    const nextCursor = result.has_more && result.last_sort_value !== undefined && result.last_id
      ? encodeCursor(result.last_sort_value, result.last_id)
      : null

    return reply.send({
      data: result.data,
      pagination: {
        next_cursor: nextCursor,
        has_more: result.has_more,
        limit,
      },
    })
  })

  // ---- GET /v1/oracle/agents/leaderboard (Free) ----
  // MUST be registered before /:id to avoid "leaderboard" matching as :id param
  app.get('/v1/oracle/agents/leaderboard', {
    schema: {
      tags: ['agents'],
      summary: 'Agent leaderboard',
      description: 'Ranked list of agents by wallet count, protocol count, evidence count, or newest.',
      querystring: LeaderboardQuery,
      response: {
        200: LeaderboardResponse,
      },
    },
    config: {
      cache: {
        ttl: 60,
        key: (request: { query: Record<string, string>; tenant?: { plan: string } }) => {
          const q = request.query
          const version = (globalThis as Record<string, unknown>).__lbVersion ?? 0
          const sort = q.sort ?? 'wallet_count'
          const cursor = q.cursor ?? ''
          const plan = request.tenant?.plan ?? 'free'
          return keys.leaderboard(version as number, sort, cursor, plan)
        },
      },
      rateLimit: { max: 60 },
    },
  }, async (request, reply) => {
    const query = request.query as {
      sort?: 'wallet_count' | 'protocol_count' | 'evidence_count' | 'newest'
      limit?: number
      cursor?: string
    }

    const sort = query.sort ?? 'wallet_count'
    const limit = query.limit ?? 20

    // Decode cursor if present
    let cursorValue: number | string | undefined
    let cursorId: string | undefined
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (decoded) {
        cursorValue = decoded.s
        cursorId = decoded.id
      }
    }

    const result = await service.leaderboard({
      sort,
      limit,
      offset: 0,
      cursorValue,
      cursorId,
    })

    const nextCursor = result.has_more && result.last_sort_value !== undefined && result.last_id
      ? encodeCursor(result.last_sort_value, result.last_id)
      : null

    return reply.send({
      data: result.data,
      pagination: {
        next_cursor: nextCursor,
        has_more: result.has_more,
        limit,
      },
    })
  })

  // ---- GET /v1/oracle/agents/model-usage (Pro) ----
  // MUST be registered before /:id to avoid "model-usage" matching as :id param
  app.get('/v1/oracle/agents/model-usage', {
    schema: {
      tags: ['agents'],
      summary: 'Get model usage distribution',
      description: 'LLM model/provider distribution across the agent economy. Requires pro tier.',
      querystring: ModelUsageQuery,
      security: [{ apiKey: [] }],
      response: {
        200: ModelUsageResponse,
        403: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
    config: {
      cache: {
        ttl: 120,
        key: (request: { query: Record<string, string>; tenant?: { plan: string } }) => {
          const period = request.query.period ?? '7d'
          const limit = request.query.limit ?? '20'
          const plan = request.tenant?.plan ?? 'free'
          return keys.modelUsage(period, Number(limit), plan)
        },
      },
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const query = request.query as { period?: string; limit?: number }
    const period = query.period ?? '7d'
    const limit = query.limit ?? 20

    // ClickHouse not available → empty data
    if (!clickhouse) {
      return reply.send({
        data: { period, has_data: false, models: [], total_events: 0 },
      })
    }

    const result = await clickhouse.queryModelUsage(period, limit)

    const models = result.models.map((m) => ({
      ...m,
      pct: result.total_events > 0
        ? Math.round((m.event_count / result.total_events) * 1000) / 10
        : 0,
    }))

    return reply.send({
      data: {
        period,
        has_data: models.length > 0,
        models,
        total_events: result.total_events,
      },
    })
  })

  // ---- GET /v1/oracle/agents/:id (Free) ----
  app.get('/v1/oracle/agents/:id', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent profile',
      description: 'Retrieve an agent entity profile including wallets, protocols, and reputation.',
      params: AgentIdParams,
      response: {
        200: AgentProfileResponse,
        404: { $ref: 'ProblemDetail' },
      },
    },
    config: {
      cache: {
        ttl: 30,
        key: (request: { params: Record<string, string>; tenant?: { plan: string } }) => {
          return keys.agentProfile(request.params.id)
        },
      },
      rateLimit: { max: 60 },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const agent = await service.getProfile(id)
    if (!agent) {
      return sendProblem(reply, 404, {
        type: 'agent-not-found',
        title: 'Agent Not Found',
        detail: `No agent entity found with id '${id}'.`,
        code: 'AGENT_NOT_FOUND',
      })
    }

    // Map service shape to API shape
    const reputation = agent.reputation_json && agent.reputation_updated_at
      ? { score: (agent.reputation_json as Record<string, unknown>).score as number ?? 0, updated_at: agent.reputation_updated_at }
      : null

    return reply.send({
      data: {
        id: agent.id,
        display_name: agent.display_name,
        erc8004_id: agent.erc8004_id,
        lucid_tenant: agent.lucid_tenant,
        reputation,
        wallets: agent.wallets,
        protocols: agent.identity_links,
        stats: {
          wallet_count: agent.wallets.length,
          protocol_count: agent.identity_links.length,
          evidence_count: agent.evidence_count,
        },
        created_at: agent.created_at,
        updated_at: agent.updated_at,
      },
    })
  })

  // ---- GET /v1/oracle/agents/:id/metrics (Pro) ----
  app.get('/v1/oracle/agents/:id/metrics', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent metrics',
      description: 'Detailed wallet, evidence, protocol, and conflict metrics for an agent. Requires pro tier.',
      params: AgentIdParams,
      security: [{ apiKey: [] }],
      response: {
        200: AgentMetricsResponse,
        403: { $ref: 'ProblemDetail' },
        404: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
    config: {
      cache: {
        ttl: 60,
        key: (request: { params: Record<string, string>; tenant?: { plan: string } }) => {
          const id = request.params.id
          const plan = request.tenant?.plan ?? 'free'
          return keys.agentMetrics(id, plan)
        },
      },
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    const metrics = await service.getMetrics(id)
    if (!metrics) {
      return sendProblem(reply, 404, {
        type: 'agent-not-found',
        title: 'Agent Not Found',
        detail: `No agent entity found with id '${id}'.`,
        code: 'AGENT_NOT_FOUND',
      })
    }

    return reply.send({
      data: {
        agent_id: metrics.id,
        wallets: metrics.wallets,
        evidence: metrics.evidence,
        protocols: metrics.protocols,
        conflicts: metrics.conflicts,
        first_seen: metrics.first_seen,
        last_active: metrics.last_active,
      },
    })
  })

  // ---- GET /v1/oracle/agents/:id/activity (Pro) ----
  app.get('/v1/oracle/agents/:id/activity', {
    schema: {
      tags: ['agents'],
      summary: 'Get agent activity',
      description: 'Chronological activity feed for an agent (wallet links, evidence, conflicts). Requires pro tier.',
      params: AgentIdParams,
      querystring: ActivityQuery,
      security: [{ apiKey: [] }],
      response: {
        200: ActivityResponse,
        403: { $ref: 'ProblemDetail' },
        404: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
    config: {
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }

    // Lightweight existence check
    const exists = await service.exists(id)
    if (!exists) {
      return sendProblem(reply, 404, {
        type: 'agent-not-found',
        title: 'Agent Not Found',
        detail: `No agent entity found with id '${id}'.`,
        code: 'AGENT_NOT_FOUND',
      })
    }

    const query = request.query as { limit?: number; cursor?: string }
    const limit = query.limit ?? 20

    // Decode cursor if present
    let cursorTimestamp: string | undefined
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor)
      if (decoded) {
        cursorTimestamp = String(decoded.s)
      }
    }

    const result = await service.getActivity(id, {
      limit,
      offset: 0,
      cursorTimestamp,
    })

    const nextCursor = result.has_more && result.last_sort_value !== undefined
      ? encodeCursor(result.last_sort_value, id)
      : null

    return reply.send({
      data: result.data,
      pagination: {
        next_cursor: nextCursor,
        has_more: result.has_more,
        limit,
      },
    })
  })
}
