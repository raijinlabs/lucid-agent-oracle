import type { FastifyInstance } from 'fastify'
import type { DbClient } from '@lucid/oracle-core'
import { AgentQueryService } from '../services/agent-query.js'

const ALLOWED_SORTS = ['wallet_count', 'protocol_count', 'evidence_count', 'newest'] as const

export function registerAgentRoutes(app: FastifyInstance, db: DbClient): void {
  const service = new AgentQueryService(db)

  // ---- GET /v1/oracle/agents/search ----
  // MUST be registered before /:id to avoid "search" matching as :id param
  app.get('/v1/oracle/agents/search', async (request, reply) => {
    const query = request.query as Record<string, string>
    const { wallet, chain, protocol, protocol_id, erc8004_id, q } = query

    // At least one search param required (chain alone is not a valid search — it's a sub-filter for wallet)
    if (!wallet && !protocol && !protocol_id && !erc8004_id && !q) {
      return reply.status(400).send({
        error: 'At least one search parameter required (wallet, chain, protocol, protocol_id, erc8004_id, q)',
      })
    }

    const limit = Math.min(parseInt(query.limit ?? '20', 10) || 20, 100)
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0)

    const result = await service.search({
      wallet, chain, protocol, protocol_id, erc8004_id, q, limit, offset,
    })

    return reply.send({ agents: result.agents, total: result.total, limit, offset })
  })

  // ---- GET /v1/oracle/agents/leaderboard ----
  // MUST be registered before /:id to avoid "leaderboard" matching as :id param
  app.get('/v1/oracle/agents/leaderboard', async (request, reply) => {
    const query = request.query as Record<string, string>
    const sortParam = query.sort ?? 'wallet_count'
    const sort = ALLOWED_SORTS.includes(sortParam as any)
      ? (sortParam as typeof ALLOWED_SORTS[number])
      : 'wallet_count'
    const limit = Math.min(parseInt(query.limit ?? '20', 10) || 20, 100)
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0)

    const result = await service.leaderboard({ sort, limit, offset })

    return reply.send({ agents: result.agents, sort, total: result.total, limit, offset })
  })

  // ---- GET /v1/oracle/agents/:id ----
  app.get('/v1/oracle/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string }

    const agent = await service.getProfile(id)
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' })
    }

    return reply.send({ agent })
  })

  // ---- GET /v1/oracle/agents/:id/metrics (Pro) ----
  app.get('/v1/oracle/agents/:id/metrics', async (request, reply) => {
    const tier = (request.headers['x-api-tier'] as string) ?? 'free'
    if (tier === 'free') {
      return reply.status(403).send({ error: 'Pro tier required' })
    }

    const { id } = request.params as { id: string }

    const metrics = await service.getMetrics(id)
    if (!metrics) {
      return reply.status(404).send({ error: 'Agent not found' })
    }

    return reply.send(metrics)
  })

  // ---- GET /v1/oracle/agents/:id/activity (Pro) ----
  app.get('/v1/oracle/agents/:id/activity', async (request, reply) => {
    const tier = (request.headers['x-api-tier'] as string) ?? 'free'
    if (tier === 'free') {
      return reply.status(403).send({ error: 'Pro tier required' })
    }

    const { id } = request.params as { id: string }

    // Lightweight existence check instead of full profile load
    const exists = await service.exists(id)
    if (!exists) {
      return reply.status(404).send({ error: 'Agent not found' })
    }

    const query = request.query as Record<string, string>
    const limit = Math.min(parseInt(query.limit ?? '20', 10) || 20, 100)
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0)

    const result = await service.getActivity(id, { limit, offset })

    return reply.send({ agent_id: id, events: result.events, limit, offset })
  })
}
