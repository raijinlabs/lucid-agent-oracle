import fp from 'fastify-plugin'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { DbClient } from '@lucid/oracle-core'
import type { RedisClientType } from 'redis'
import { keys } from '../services/redis.js'

// ---------------------------------------------------------------------------
// Module augmentation — stable request.tenant shape on every request
// ---------------------------------------------------------------------------
declare module 'fastify' {
  interface FastifyRequest {
    tenant: { id: string | null; plan: string }
  }
}

// ---------------------------------------------------------------------------
// Tier rank
// ---------------------------------------------------------------------------

const TIER_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  growth: 2,
}

function tierRank(plan: string): number {
  return TIER_RANK[plan] ?? 0
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface AuthPluginOptions {
  db: DbClient
  redis?: RedisClientType | null
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

const AUTH_TTL = 300 // 5 minutes

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (fastify, opts) => {
  const { db, redis } = opts

  // Decorate with a default shape so TypeScript is happy before any hook runs
  fastify.decorateRequest('tenant', null as unknown as { id: string | null; plan: string })

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const apiKey = request.headers['x-api-key']

    // No key → anonymous free-tier
    if (!apiKey || typeof apiKey !== 'string') {
      request.tenant = { id: null, plan: 'free' }
      return
    }

    // Try Redis cache first
    if (redis) {
      try {
        const cached = await redis.get(keys.apiKey(apiKey))
        if (cached) {
          request.tenant = JSON.parse(cached) as { id: string; plan: string }
          return
        }
      } catch {
        // Redis failure is non-fatal — fall through to DB
      }
    }

    // Cache miss — query DB
    const result = await db.query(
      'SELECT id, plan FROM gateway_tenants WHERE api_key = $1 AND active = true LIMIT 1',
      [apiKey],
    )

    if (result.rows.length === 0) {
      // Unknown / revoked key → 401 RFC 9457 Problem Details
      reply
        .code(401)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://oracle.lucid.foundation/errors/invalid-api-key',
          title: 'Invalid API Key',
          status: 401,
          detail: 'The provided API key is not recognised or has been revoked.',
        })
      return
    }

    const row = result.rows[0] as { id: string; plan: string }
    request.tenant = { id: row.id, plan: row.plan }

    // Populate Redis cache
    if (redis) {
      try {
        await redis.set(keys.apiKey(apiKey), JSON.stringify(request.tenant), { EX: AUTH_TTL })
      } catch {
        // Non-fatal
      }
    }
  })
}

export const authPlugin = fp(authPluginImpl, {
  name: 'auth',
  fastify: '5.x',
})

// ---------------------------------------------------------------------------
// requireTier helper — returns a preHandler that enforces minimum plan
// ---------------------------------------------------------------------------

export function requireTier(minTier: 'pro' | 'growth') {
  return async function tierPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const tenantRank = tierRank(request.tenant.plan)
    const minRank = tierRank(minTier)

    if (tenantRank < minRank) {
      reply
        .code(403)
        .header('content-type', 'application/problem+json')
        .send({
          type: 'https://oracle.lucid.foundation/errors/tier-required',
          title: 'Insufficient Plan Tier',
          status: 403,
          detail: `This endpoint requires plan '${minTier}' or higher. Your current plan is '${request.tenant.plan}'.`,
        })
    }
  }
}
