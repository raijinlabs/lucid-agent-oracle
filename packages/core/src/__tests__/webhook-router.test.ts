import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mountWebhookRoutes } from '../adapters/webhook-router.js'
import { adapterRegistry } from '../adapters/registry.js'
import type { AdapterDefinition, WebhookContext } from '../adapters/adapter-types.js'

describe('mountWebhookRoutes', () => {
  beforeEach(() => {
    adapterRegistry.clear()
  })

  it('returns 0 when no adapters have webhooks', () => {
    adapterRegistry.register({
      source: 'plain',
      version: 1,
      description: 'test',
      topic: 'raw.plain.events',
      chains: ['offchain'],
    })

    const count = mountWebhookRoutes({} as any, {} as any, { env: {}, services: {} })
    expect(count).toBe(0)
  })

  it('mounts webhook routes from registry', () => {
    const mountFn = vi.fn()
    adapterRegistry.register({
      source: 'hooked',
      version: 1,
      description: 'test',
      topic: 'raw.hooked.events',
      chains: ['solana'],
      webhook: {
        path: '/test/webhook',
        mount: mountFn,
      },
    })

    const app = {} as any
    const producer = {} as any
    const context: WebhookContext = { env: {}, services: {} }

    const count = mountWebhookRoutes(app, producer, context)
    expect(count).toBe(1)
    expect(mountFn).toHaveBeenCalledWith(app, producer, context)
  })

  it('handles mount errors gracefully', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    adapterRegistry.register({
      source: 'broken',
      version: 1,
      description: 'test',
      topic: 'raw.broken.events',
      chains: ['offchain'],
      webhook: {
        path: '/broken',
        mount: () => { throw new Error('mount failed') },
      },
    })

    const count = mountWebhookRoutes({} as any, {} as any, { env: {}, services: {} })
    expect(count).toBe(0)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('mounts multiple webhook adapters', () => {
    const mount1 = vi.fn()
    const mount2 = vi.fn()

    adapterRegistry.register({
      source: 'a',
      version: 1,
      description: 'test',
      topic: 'raw.a.events',
      chains: ['offchain'],
      webhook: { path: '/a', mount: mount1 },
    })
    adapterRegistry.register({
      source: 'b',
      version: 1,
      description: 'test',
      topic: 'raw.b.events',
      chains: ['offchain'],
      webhook: { path: '/b', mount: mount2 },
    })

    const count = mountWebhookRoutes({} as any, {} as any, { env: {}, services: {} })
    expect(count).toBe(2)
    expect(mount1).toHaveBeenCalled()
    expect(mount2).toHaveBeenCalled()
  })
})
