import type { FastifyInstance } from 'fastify'
import type { DbClient } from '@lucid/oracle-core'
import { AgentQueryService, PROTOCOL_REGISTRY } from '../services/agent-query.js'
import { keys } from '../services/redis.js'
import { ProtocolIdParams, sendProblem, ProblemDetail } from '../schemas/common.js'
import {
  ProtocolListResponse,
  ProtocolDetailResponse,
  ProtocolMetricsResponse,
} from '../schemas/protocols.js'
import { requireTier } from '../plugins/auth.js'

export function registerProtocolRoutes(app: FastifyInstance, db: DbClient): void {
  const service = new AgentQueryService(db)

  // ---- GET /v1/oracle/protocols ---- (Free)
  app.get('/v1/oracle/protocols', {
    schema: {
      tags: ['protocols'],
      summary: 'List protocols',
      description: 'List all indexed protocols with their chain support and status.',
      response: { 200: ProtocolListResponse },
    },
    config: {
      cache: { ttl: 120, key: () => keys.protocolList() },
      rateLimit: { max: 60 },
    },
  }, async (_request, reply) => {
    const data = Object.entries(PROTOCOL_REGISTRY).map(([id, meta]) => ({
      id,
      name: meta.name,
      chains: meta.chains,
      status: meta.status,
    }))

    return reply.send({ data })
  })

  // ---- GET /v1/oracle/protocols/:id ---- (Free)
  app.get<{ Params: { id: string } }>('/v1/oracle/protocols/:id', {
    schema: {
      tags: ['protocols'],
      summary: 'Get protocol detail',
      description: 'Retrieve protocol detail including agent and wallet counts.',
      params: ProtocolIdParams,
      response: {
        200: ProtocolDetailResponse,
        404: { $ref: 'ProblemDetail' },
      },
    },
    config: {
      cache: { ttl: 60, key: (req) => keys.protocolDetail((req.params as { id: string }).id) },
      rateLimit: { max: 60 },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const protocol = await service.getProtocol(id)
    if (!protocol) {
      return sendProblem(reply, 404, {
        type: 'not-found',
        title: 'Protocol Not Found',
        detail: `No protocol with id '${id}' exists.`,
        instance: `/v1/oracle/protocols/${id}`,
      })
    }

    return reply.send({
      data: {
        id: protocol.id,
        name: protocol.name,
        chains: protocol.chains,
        status: protocol.status,
        stats: {
          agent_count: protocol.agent_count,
          wallet_count: protocol.wallet_count,
        },
      },
    })
  })

  // ---- GET /v1/oracle/protocols/:id/metrics ---- (Pro)
  app.get<{ Params: { id: string } }>('/v1/oracle/protocols/:id/metrics', {
    schema: {
      tags: ['protocols'],
      summary: 'Get protocol metrics',
      description: 'Detailed protocol metrics including agent counts, wallets, evidence, and recent activity. Requires pro tier.',
      params: ProtocolIdParams,
      security: [{ apiKey: [] }],
      response: {
        200: ProtocolMetricsResponse,
        403: { $ref: 'ProblemDetail' },
        404: { $ref: 'ProblemDetail' },
      },
    },
    preHandler: [requireTier('pro')],
    config: {
      cache: {
        ttl: 60,
        key: (req) => keys.protocolMetrics(
          (req.params as { id: string }).id,
          req.tenant?.plan ?? 'free',
        ),
      },
      rateLimit: { max: 30 },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const metrics = await service.getProtocolMetrics(id)
    if (!metrics) {
      return sendProblem(reply, 404, {
        type: 'not-found',
        title: 'Protocol Not Found',
        detail: `No protocol with id '${id}' exists.`,
        instance: `/v1/oracle/protocols/${id}/metrics`,
      })
    }

    return reply.send({
      data: {
        protocol_id: metrics.id,
        agents: metrics.agents,
        wallets: metrics.wallets,
        evidence: metrics.evidence,
        recent_registrations_7d: metrics.recent_registrations_7d,
        active_conflicts: metrics.active_conflicts,
      },
    })
  })
}
