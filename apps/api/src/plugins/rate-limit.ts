import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { FastifyPluginAsync } from 'fastify'
import type { RedisClientType } from 'redis'

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

export interface RateLimitPluginOptions {
  /**
   * A node-redis v4/v5 client, or null to use the in-memory store.
   *
   * NOTE: @fastify/rate-limit's `redis` option expects an ioredis-compatible
   * client (ioredis v4 API). node-redis v4/v5 uses a different API surface
   * (e.g. `.get()` returns a Promise directly vs. callbacks, different event
   * model). Passing a node-redis client here would silently produce incorrect
   * behavior. We therefore skip the Redis store when redis is non-null and
   * fall back to the built-in in-memory LRU store. If distributed rate
   * limiting is required, swap in an ioredis client or a custom store.
   */
  redis: RedisClientType | null
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

const rateLimitPluginImpl: FastifyPluginAsync<RateLimitPluginOptions> = async (fastify, _opts) => {
  await fastify.register(rateLimit, {
    global: false, // only rate-limit routes that opt in via config.rateLimit

    max: 60,
    timeWindow: 60_000, // 1 minute in milliseconds

    // Use tenant ID when authenticated, fall back to IP for anonymous requests
    keyGenerator(request) {
      return request.tenant?.id ?? request.ip
    },

    // RFC 9457 Problem Details response on 429
    errorResponseBuilder(request, context) {
      const seconds = Math.ceil(context.ttl / 1000)
      return {
        type: 'https://oracle.lucid.foundation/errors/rate-limited',
        title: 'Rate limit exceeded',
        status: 429,
        detail: `Rate limit exceeded. Try again in ${seconds} second${seconds !== 1 ? 's' : ''}.`,
      }
    },

    // No ioredis store — node-redis v4/v5 is not compatible (see options comment above)
  })
}

export default fp(rateLimitPluginImpl, {
  name: 'rate-limit',
  fastify: '5.x',
})
