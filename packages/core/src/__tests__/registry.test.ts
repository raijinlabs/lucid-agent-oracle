import { describe, it, expect, beforeEach } from 'vitest'
import { AdapterRegistry } from '../adapters/registry.js'
import type { AdapterDefinition } from '../adapters/adapter-types.js'

function makeAdapter(source: string, overrides?: Partial<AdapterDefinition>): AdapterDefinition {
  return {
    source,
    version: 1,
    description: `Test adapter for ${source}`,
    topic: `raw.${source}.events`,
    chains: ['offchain'],
    ...overrides,
  }
}

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry

  beforeEach(() => {
    registry = new AdapterRegistry()
  })

  it('registers and retrieves an adapter', () => {
    const adapter = makeAdapter('test_source')
    registry.register(adapter)

    expect(registry.get('test_source')).toBe(adapter)
    expect(registry.size).toBe(1)
  })

  it('throws on duplicate registration', () => {
    registry.register(makeAdapter('dup'))
    expect(() => registry.register(makeAdapter('dup'))).toThrow(/already registered/)
  })

  it('replace() overwrites existing adapter', () => {
    const v1 = makeAdapter('source', { version: 1 })
    const v2 = makeAdapter('source', { version: 2 })

    registry.register(v1)
    registry.replace(v2)

    expect(registry.get('source')?.version).toBe(2)
    expect(registry.size).toBe(1)
  })

  it('getOrThrow() throws for unknown source', () => {
    expect(() => registry.getOrThrow('nope')).toThrow(/No adapter registered/)
  })

  it('list() returns all adapters', () => {
    registry.register(makeAdapter('a'))
    registry.register(makeAdapter('b'))
    registry.register(makeAdapter('c'))

    expect(registry.list()).toHaveLength(3)
    expect(registry.sources()).toEqual(['a', 'b', 'c'])
  })

  it('getByTopic() finds adapter by topic', () => {
    registry.register(makeAdapter('foo', { topic: 'raw.foo.events' }))
    registry.register(makeAdapter('bar', { topic: 'raw.bar.events' }))

    expect(registry.getByTopic('raw.foo.events')?.source).toBe('foo')
    expect(registry.getByTopic('nonexistent')).toBeUndefined()
  })

  it('withWebhook() filters adapters with webhook handlers', () => {
    const noWebhook = makeAdapter('plain')
    const withWebhook = makeAdapter('hooked', {
      webhook: {
        path: '/webhook',
        mount: () => {},
      },
    })

    registry.register(noWebhook)
    registry.register(withWebhook)

    const result = registry.withWebhook()
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('hooked')
  })

  it('withIdentity() filters adapters with identity handlers', () => {
    const noIdentity = makeAdapter('plain')
    const withIdentity = makeAdapter('identified', {
      identity: {
        handles: ['agent_registered'],
        handleEvent: async () => {},
      },
    })

    registry.register(noIdentity)
    registry.register(withIdentity)

    const result = registry.withIdentity()
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('identified')
  })

  it('remove() deletes adapter', () => {
    registry.register(makeAdapter('temp'))
    expect(registry.remove('temp')).toBe(true)
    expect(registry.get('temp')).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('clear() empties registry', () => {
    registry.register(makeAdapter('a'))
    registry.register(makeAdapter('b'))
    registry.clear()
    expect(registry.size).toBe(0)
  })
})
