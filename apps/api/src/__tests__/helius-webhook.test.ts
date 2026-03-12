import { describe, it, expect } from 'vitest'
import { handleHeliusWebhook, verifyHeliusHmac } from '../routes/helius-webhook.js'

describe('Helius webhook', () => {
  it('verifies valid HMAC signature', () => {
    const { createHmac } = require('node:crypto')
    const body = '{"test":"data"}'
    const secret = 'test-secret-123'
    const sig = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyHeliusHmac(body, sig, secret)).toBe(true)
  })

  it('rejects invalid HMAC signature', () => {
    expect(verifyHeliusHmac('{"test":"data"}', 'bad-sig', 'secret')).toBe(false)
  })

  it('normalizes webhook payload into events', () => {
    const watchedWallets = new Set(['SolWallet1'])
    const tx = {
      signature: '5abc',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 100,
      nativeTransfers: [{ fromUserAccount: 'SolWallet1', toUserAccount: 'SolWallet2', amount: 1e9 }],
      tokenTransfers: [],
      accountData: [],
      description: '',
    }
    const events = handleHeliusWebhook([tx], watchedWallets)
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('agent_wallets_sol')
    expect(events[0].subject_raw_id).toBe('SolWallet1')
  })

  it('skips transactions not involving watched wallets', () => {
    const watchedWallets = new Set(['SolWallet1'])
    const tx = {
      signature: '5def',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 101,
      nativeTransfers: [{ fromUserAccount: 'Other1', toUserAccount: 'Other2', amount: 500 }],
      tokenTransfers: [],
      accountData: [],
      description: '',
    }
    const events = handleHeliusWebhook([tx], watchedWallets)
    expect(events).toHaveLength(0)
  })
})
