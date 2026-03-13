import { describe, it, expect, beforeEach } from 'vitest'
import { VerifierRegistry } from '../identity/wallet-verifier.js'
import type { WalletVerifier } from '../identity/wallet-verifier.js'

describe('VerifierRegistry', () => {
  let registry: VerifierRegistry

  beforeEach(() => {
    registry = new VerifierRegistry()
  })

  it('registers a verifier and looks it up by chain', () => {
    const mock: WalletVerifier = {
      chains: ['base', 'ethereum'],
      verify: async () => true,
    }
    registry.register(mock)
    expect(registry.getForChain('base')).toBe(mock)
    expect(registry.getForChain('ethereum')).toBe(mock)
    expect(registry.getForChain('solana')).toBeUndefined()
  })

  it('throws on duplicate chain registration', () => {
    const a: WalletVerifier = { chains: ['base'], verify: async () => true }
    const b: WalletVerifier = { chains: ['base'], verify: async () => true }
    registry.register(a)
    expect(() => registry.register(b)).toThrow('already registered')
  })

  it('lists all supported chains', () => {
    const evm: WalletVerifier = { chains: ['base', 'ethereum'], verify: async () => true }
    const sol: WalletVerifier = { chains: ['solana'], verify: async () => true }
    registry.register(evm)
    registry.register(sol)
    expect(registry.supportedChains()).toEqual(['base', 'ethereum', 'solana'])
  })
})
