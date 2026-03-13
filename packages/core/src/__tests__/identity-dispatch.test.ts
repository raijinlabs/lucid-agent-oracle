import { describe, it, expect, beforeEach, vi } from 'vitest'
import { dispatchIdentityEvent, getIdentityTopics } from '../adapters/identity-dispatch.js'
import { adapterRegistry } from '../adapters/registry.js'
import { registerDefaultAdapters } from '../adapters/register-defaults.js'
import type { AdapterDefinition } from '../adapters/adapter-types.js'

describe('dispatchIdentityEvent', () => {
  beforeEach(() => {
    adapterRegistry.clear()
  })

  it('returns false for unregistered source', async () => {
    const result = await dispatchIdentityEvent('unknown', {}, {} as any, {} as any)
    expect(result).toBe(false)
  })

  it('returns false for source with no identity handler', async () => {
    adapterRegistry.register({
      source: 'no_identity',
      version: 1,
      description: 'test',
      topic: 'raw.no_identity.events',
      chains: ['offchain'],
    })
    const result = await dispatchIdentityEvent('no_identity', {}, {} as any, {} as any)
    expect(result).toBe(false)
  })

  it('dispatches to the correct identity handler', async () => {
    const mockHandler = vi.fn()
    const adapter: AdapterDefinition = {
      source: 'test_protocol',
      version: 1,
      description: 'test',
      topic: 'raw.test_protocol.events',
      chains: ['base'],
      identity: {
        handles: ['registered'],
        handleEvent: mockHandler,
      },
    }
    adapterRegistry.register(adapter)

    const db = {} as any
    const producer = {} as any
    const event = { source: 'test_protocol', event_type: 'registered' }

    const result = await dispatchIdentityEvent('test_protocol', event, db, producer)
    expect(result).toBe(true)
    expect(mockHandler).toHaveBeenCalledWith(event, db, producer)
  })
})

describe('getIdentityTopics', () => {
  beforeEach(() => {
    adapterRegistry.clear()
    registerDefaultAdapters()
  })

  it('returns topics for adapters with identity handlers', () => {
    const topics = getIdentityTopics()
    // Only erc8004 has an identity handler among defaults
    expect(topics).toContain('raw.erc8004.events')
    expect(topics).toHaveLength(1)
  })

  it('returns empty array when no adapters have identity handlers', () => {
    adapterRegistry.clear()
    adapterRegistry.register({
      source: 'plain',
      version: 1,
      description: 'test',
      topic: 'raw.plain.events',
      chains: ['offchain'],
    })
    expect(getIdentityTopics()).toHaveLength(0)
  })
})
