import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AdapterRegistry } from '../adapters/registry.js'
import { topicForSource } from '../adapters/topic-for-source.js'
import { dispatchIdentityEvent } from '../adapters/identity-dispatch.js'
import { mountWebhookRoutes } from '../adapters/webhook-router.js'
import { adapterRegistry } from '../adapters/registry.js'
import type { AdapterDefinition, IdentityHandler, WebhookAdapter } from '../adapters/adapter-types.js'

/**
 * End-to-end extensibility test:
 * Demonstrates adding a completely new protocol (Virtuals ACP)
 * with webhook + identity handler in just one adapter definition.
 */
describe('Adapter extensibility — adding a new provider', () => {
  beforeEach(() => {
    adapterRegistry.clear()
  })

  it('a new adapter with webhook + identity wires up fully through the registry', () => {
    // Step 1: Define the adapter (this is ALL a developer writes for a new provider)
    const mountFn = vi.fn()
    const handleEventFn = vi.fn().mockResolvedValue(undefined)

    const virtualsAdapter: AdapterDefinition = {
      source: 'virtuals_acp',
      version: 1,
      description: 'Virtuals ACP — Agent Commerce Protocol',
      topic: 'raw.virtuals_acp.events',
      chains: ['base'],
      webhook: {
        path: '/v1/internal/virtuals/webhook',
        mount: mountFn,
      },
      identity: {
        handles: ['agent_created', 'service_purchased'],
        handleEvent: handleEventFn,
      },
    }

    // Step 2: Register it
    adapterRegistry.register(virtualsAdapter)

    // Step 3: Verify everything auto-discovers
    expect(adapterRegistry.get('virtuals_acp')).toBe(virtualsAdapter)
    expect(topicForSource('virtuals_acp')).toBe('raw.virtuals_acp.events')
    expect(adapterRegistry.withWebhook()).toHaveLength(1)
    expect(adapterRegistry.withIdentity()).toHaveLength(1)

    // Step 4: Webhook auto-mounts
    const webhookCount = mountWebhookRoutes({} as any, {} as any, { env: {}, services: {} })
    expect(webhookCount).toBe(1)
    expect(mountFn).toHaveBeenCalled()

    // Step 5: Identity dispatch works
    const db = {} as any
    const producer = {} as any
    const event = { source: 'virtuals_acp', event_type: 'agent_created' }
    dispatchIdentityEvent('virtuals_acp', event, db, producer)
    expect(handleEventFn).toHaveBeenCalledWith(event, db, producer)
  })

  it('multiple adapters coexist without conflicts', () => {
    const adapters = ['protocol_a', 'protocol_b', 'protocol_c'].map((source) => ({
      source,
      version: 1,
      description: `Adapter for ${source}`,
      topic: `raw.${source}.events`,
      chains: ['base'] as readonly string[],
    }))

    adapters.forEach((a) => adapterRegistry.register(a))

    expect(adapterRegistry.size).toBe(3)
    expect(adapterRegistry.sources()).toEqual(['protocol_a', 'protocol_b', 'protocol_c'])

    // Each resolves to its own topic
    expect(topicForSource('protocol_a')).toBe('raw.protocol_a.events')
    expect(topicForSource('protocol_b')).toBe('raw.protocol_b.events')
    expect(topicForSource('protocol_c')).toBe('raw.protocol_c.events')
  })

  it('hot-swapping an adapter works via replace()', async () => {
    const v1Handler = vi.fn().mockResolvedValue(undefined)
    const v2Handler = vi.fn().mockResolvedValue(undefined)

    adapterRegistry.register({
      source: 'swap_test',
      version: 1,
      description: 'v1',
      topic: 'raw.swap_test.events',
      chains: ['offchain'],
      identity: { handles: ['test'], handleEvent: v1Handler },
    })

    // Dispatch to v1
    await dispatchIdentityEvent('swap_test', { event_type: 'test' }, {} as any, {} as any)
    expect(v1Handler).toHaveBeenCalledTimes(1)

    // Hot-swap to v2
    adapterRegistry.replace({
      source: 'swap_test',
      version: 2,
      description: 'v2',
      topic: 'raw.swap_test.events',
      chains: ['offchain'],
      identity: { handles: ['test'], handleEvent: v2Handler },
    })

    // Dispatch now goes to v2
    await dispatchIdentityEvent('swap_test', { event_type: 'test' }, {} as any, {} as any)
    expect(v2Handler).toHaveBeenCalledTimes(1)
    expect(v1Handler).toHaveBeenCalledTimes(1) // still 1, not called again
  })
})
