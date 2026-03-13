import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import rateLimitPlugin from '../plugins/rate-limit.js'

// ---------------------------------------------------------------------------
// Shared mock auth plugin — decorates request.tenant on every request
// ---------------------------------------------------------------------------

function mockAuthPlugin() {
  return fp(async (app: any) => {
    // Fastify 5 requires getter/setter interface for reference-type decorators
    app.decorateRequest('tenant', {
      getter() {
        return { id: null, plan: 'free' }
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimitPlugin', () => {
  it('does not rate-limit routes without config (global: false)', async () => {
    const app = Fastify({ logger: false })
    await app.register(mockAuthPlugin())
    await app.register(rateLimitPlugin, { redis: null })

    // Route has NO rateLimit config — should never be limited
    app.get('/unlimited', async () => ({ ok: true }))
    await app.ready()

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/unlimited' })
      expect(res.statusCode).toBe(200)
    }

    await app.close()
  })

  it('returns RFC 9457 body on 429 when rate limited', async () => {
    const app = Fastify({ logger: false })
    await app.register(mockAuthPlugin())
    await app.register(rateLimitPlugin, { redis: null })

    // max: 1 — first request passes, second is rejected
    app.get(
      '/limited',
      { config: { rateLimit: { max: 1, timeWindow: 60000 } } },
      async () => ({ ok: true }),
    )
    await app.ready()

    const first = await app.inject({ method: 'GET', url: '/limited' })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({ method: 'GET', url: '/limited' })
    expect(second.statusCode).toBe(429)

    const body = second.json()
    expect(body.type).toContain('rate-limited')
    expect(body.status).toBe(429)
    expect(body.title).toBeDefined()
    expect(body.detail).toBeDefined()

    await app.close()
  })

  it('rate limit headers present on limited routes', async () => {
    const app = Fastify({ logger: false })
    await app.register(mockAuthPlugin())
    await app.register(rateLimitPlugin, { redis: null })

    app.get(
      '/headered',
      { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
      async () => ({ ok: true }),
    )
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/headered' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-ratelimit-limit']).toBeDefined()

    await app.close()
  })
})
