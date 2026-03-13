import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  verifierRegistry,
  formatChallengeMessage,
  formatAuthMessage,
  CHALLENGE_TTL_MS,
  AUTH_SIGNATURE_MAX_AGE_MS,
} from '@lucid/oracle-core'
import type { DbClient, RedpandaProducer } from '@lucid/oracle-core'
import { RegistrationHandler } from '../services/registration-handler.js'
import { RateLimiter } from '../services/rate-limiter.js'

const challengeRateByAddr = new RateLimiter(60_000, 10)
const challengeRateByIP = new RateLimiter(60_000, 30)
const registerRateByAddr = new RateLimiter(60_000, 5)
const registerRateByIP = new RateLimiter(60_000, 15)

export function registerIdentityRoutes(
  app: FastifyInstance,
  db: DbClient,
  producer: RedpandaProducer,
): void {
  const handler = new RegistrationHandler(db, producer, verifierRegistry)

  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'staging'

  // POST /v1/oracle/agents/challenge
  app.post('/v1/oracle/agents/challenge', async (request, reply) => {
    const body = request.body as Record<string, string | undefined>
    const { chain, address, target_entity, auth_chain, auth_address, auth_signature } = body

    if (!chain || !address) {
      return reply.status(400).send({ error: 'chain and address are required' })
    }

    // Rate limit
    const addrKey = `${chain}:${address}`
    const ip = request.ip
    if (!challengeRateByAddr.check(addrKey)) {
      return reply.status(429).send({
        error: 'Rate limit exceeded',
        retry_after_ms: challengeRateByAddr.retryAfterMs(addrKey),
      })
    }
    if (!challengeRateByIP.check(ip)) {
      return reply.status(429).send({
        error: 'Rate limit exceeded',
        retry_after_ms: challengeRateByIP.retryAfterMs(ip),
      })
    }

    // Verify chain is supported
    const verifier = verifierRegistry.getForChain(chain)
    if (!verifier) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` })
    }

    // If target_entity is set, require auth proof
    if (target_entity) {
      if (!auth_chain || !auth_address || !auth_signature) {
        return reply.status(400).send({ error: 'auth_chain, auth_address, and auth_signature required when target_entity is set' })
      }

      // Validate auth_timestamp from client
      const auth_timestamp = body.auth_timestamp
      if (!auth_timestamp) {
        return reply.status(400).send({ error: 'auth_timestamp required when target_entity is set' })
      }
      const authTime = new Date(auth_timestamp)
      if (isNaN(authTime.getTime()) || Date.now() - authTime.getTime() > AUTH_SIGNATURE_MAX_AGE_MS) {
        return reply.status(400).send({ error: 'auth_timestamp expired or invalid (max 5 minutes)' })
      }

      // Verify auth_signature cryptographically
      const authVerifier = verifierRegistry.getForChain(auth_chain)
      if (!authVerifier) {
        return reply.status(400).send({ error: `Unsupported auth_chain: ${auth_chain}` })
      }

      const authMsg = formatAuthMessage({
        targetEntity: target_entity,
        newAddress: address,
        newChain: chain,
        authAddress: auth_address,
        authChain: auth_chain,
        environment,
        timestamp: auth_timestamp,
      })

      const authValid = await authVerifier.verify(auth_address, authMsg, auth_signature)
      if (!authValid) {
        return reply.status(401).send({ error: 'Auth signature verification failed' })
      }

      // Verify auth wallet is mapped to target entity
      const { rows } = await db.query(
        `SELECT id FROM wallet_mappings
         WHERE chain = $1 AND LOWER(address) = LOWER($2)
         AND agent_entity = $3 AND removed_at IS NULL`,
        [auth_chain, auth_address, target_entity],
      )
      if (rows.length === 0) {
        return reply.status(403).send({ error: 'Auth address not mapped to target entity' })
      }
    }

    // Generate challenge
    const nonce = randomUUID()
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)

    const message = formatChallengeMessage({
      agentEntity: target_entity ?? 'new',
      address,
      chain,
      environment,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Store challenge
    await db.query(
      `INSERT INTO registration_challenges
       (nonce, chain, address, target_entity, auth_chain, auth_address, message, environment, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [nonce, chain, address, target_entity ?? null, auth_chain ?? null, auth_address ?? null, message, environment, expiresAt],
    )

    return reply.send({ nonce, message, expires_at: expiresAt.toISOString() })
  })

  // POST /v1/oracle/agents/register
  app.post('/v1/oracle/agents/register', async (request, reply) => {
    const body = request.body as Record<string, string | undefined>
    const { nonce, signature } = body

    if (!nonce || !signature) {
      return reply.status(400).send({ error: 'nonce and signature are required' })
    }

    // Look up challenge to get address for rate limiting
    const { rows: challenges } = await db.query(
      'SELECT chain, address FROM registration_challenges WHERE nonce = $1',
      [nonce],
    )
    if (challenges.length > 0) {
      const c = challenges[0] as Record<string, string>
      const addrKey = `${c.chain}:${c.address}`
      const ip = request.ip
      if (!registerRateByAddr.check(addrKey)) {
        return reply.status(429).send({
          error: 'Rate limit exceeded',
          retry_after_ms: registerRateByAddr.retryAfterMs(addrKey),
        })
      }
      if (!registerRateByIP.check(ip)) {
        return reply.status(429).send({
          error: 'Rate limit exceeded',
          retry_after_ms: registerRateByIP.retryAfterMs(ip),
        })
      }
    }

    const result = await handler.register(nonce, signature)

    if (result.error && !result.data) {
      return reply.status(result.status).send({ error: result.error })
    }
    if (result.status === 409) {
      return reply.status(409).send({
        error: result.error,
        conflict_id: result.data?.conflict_id,
      })
    }

    return reply.status(result.status).send(result.data)
  })
}

/** Clean up expired challenges — runs on startup + every 15 minutes */
export async function cleanupExpiredChallenges(db: DbClient): Promise<number> {
  const { rows } = await db.query(
    `DELETE FROM registration_challenges
     WHERE expires_at < now() - interval '1 hour'
     RETURNING nonce`,
  )
  return rows.length
}
