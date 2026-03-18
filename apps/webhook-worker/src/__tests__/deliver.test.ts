import { describe, it, expect } from 'vitest'
import { buildDeliveryPayload, signPayload } from '../deliver.js'

describe('Delivery', () => {
  it('builds a correctly shaped webhook payload', () => {
    const payload = buildDeliveryPayload('evt_1', 'feeds', {
      feedId: 'aegdp',
      value: 152.3,
      confidence: 0.94,
    })

    expect(payload).toMatchObject({
      id: 'evt_1',
      channel: 'feeds',
      data: { feedId: 'aegdp', value: 152.3, confidence: 0.94 },
    })
    expect(payload.timestamp).toBeDefined()
  })

  it('signs a payload with HMAC-SHA256', () => {
    const body = JSON.stringify({ id: 'evt_1', channel: 'feeds', data: {} })
    const sig = signPayload(body, 'test-secret')

    expect(sig).toMatch(/^[a-f0-9]{64}$/) // SHA256 hex
  })

  it('produces different signatures for different secrets', () => {
    const body = JSON.stringify({ id: 'evt_1' })
    const sig1 = signPayload(body, 'secret-1')
    const sig2 = signPayload(body, 'secret-2')

    expect(sig1).not.toBe(sig2)
  })
})
