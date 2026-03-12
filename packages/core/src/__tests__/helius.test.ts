import { describe, it, expect } from 'vitest'
import { normalizeHeliusTransaction, verifyHeliusSignature } from '../adapters/helius.js'

describe('Helius adapter', () => {
  it('normalizes a SOL transfer', () => {
    const event = normalizeHeliusTransaction({
      signature: '5abc123',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 12345,
      nativeTransfers: [
        { fromUserAccount: 'SolWallet1', toUserAccount: 'SolWallet2', amount: 1_000_000_000 },
      ],
      tokenTransfers: [],
      accountData: [],
      description: 'SOL transfer',
    }, 'SolWallet1')
    expect(event).not.toBeNull()
    expect(event!.source).toBe('agent_wallets_sol')
    expect(event!.chain).toBe('solana')
    expect(event!.event_type).toBe('transfer')
    expect(event!.subject_raw_id).toBe('SolWallet1')
    expect(event!.counterparty_raw_id).toBe('SolWallet2')
    expect(event!.amount).toBe('1000000000')
    expect(event!.currency).toBe('SOL')
    expect(event!.protocol).toBe('independent')
    expect(event!.economic_authentic).toBe(true)
  })

  it('normalizes a SPL token transfer', () => {
    const event = normalizeHeliusTransaction({
      signature: '5def456',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 12346,
      nativeTransfers: [],
      tokenTransfers: [
        { fromUserAccount: 'SolWallet1', toUserAccount: 'SolWallet3', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenAmount: 100, tokenStandard: 'Fungible' },
      ],
      accountData: [],
      description: 'USDC transfer',
    }, 'SolWallet1')
    expect(event).not.toBeNull()
    expect(event!.currency).toBe('USDC')
    expect(event!.amount).toBe('100')
  })

  it('returns null for transactions not involving watched wallet', () => {
    const event = normalizeHeliusTransaction({
      signature: '5ghi789',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 12347,
      nativeTransfers: [
        { fromUserAccount: 'Other1', toUserAccount: 'Other2', amount: 500 },
      ],
      tokenTransfers: [],
      accountData: [],
      description: 'unrelated transfer',
    }, 'SolWallet1')
    expect(event).toBeNull()
  })

  it('produces deterministic event IDs', () => {
    const input = {
      signature: '5abc123',
      type: 'TRANSFER' as const,
      timestamp: 1710288000,
      slot: 12345,
      nativeTransfers: [{ fromUserAccount: 'W1', toUserAccount: 'W2', amount: 100 }],
      tokenTransfers: [],
      accountData: [],
      description: '',
    }
    const a = normalizeHeliusTransaction(input, 'W1')
    const b = normalizeHeliusTransaction(input, 'W1')
    expect(a!.event_id).toBe(b!.event_id)
  })

  it('verifies valid HMAC signature', () => {
    const { createHmac } = require('node:crypto')
    const body = '{"test":"data"}'
    const secret = 'test-secret-123'
    const sig = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyHeliusSignature(body, sig, secret)).toBe(true)
  })

  it('rejects invalid HMAC signature', () => {
    expect(verifyHeliusSignature('{"test":"data"}', 'bad-sig', 'secret')).toBe(false)
  })
})
