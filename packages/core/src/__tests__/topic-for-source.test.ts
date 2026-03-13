import { describe, it, expect, beforeEach } from 'vitest'
import { topicForSource } from '../adapters/topic-for-source.js'
import { adapterRegistry } from '../adapters/registry.js'
import { registerDefaultAdapters } from '../adapters/register-defaults.js'

describe('topicForSource', () => {
  beforeEach(() => {
    adapterRegistry.clear()
    registerDefaultAdapters()
  })

  it('returns registered topic for known source', () => {
    expect(topicForSource('erc8004')).toBe('raw.erc8004.events')
    expect(topicForSource('lucid_gateway')).toBe('raw.lucid_gateway.events')
    expect(topicForSource('agent_wallets_sol')).toBe('raw.agent_wallets.events')
  })

  it('falls back to convention for unknown source', () => {
    expect(topicForSource('custom_source')).toBe('raw.custom_source.events')
  })
})
