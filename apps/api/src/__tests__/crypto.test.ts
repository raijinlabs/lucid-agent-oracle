import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
  signWebhookPayload,
  verifyWebhookSignature,
  validateWebhookUrl,
} from '../utils/crypto.js'

describe('Webhook crypto', () => {
  const encryptionKey = 'a-32-byte-key-for-aes256-gcm!!!!' // exactly 32 bytes

  beforeEach(() => {
    vi.stubEnv('WEBHOOK_SECRET_KEY', encryptionKey)
  })

  it('generateWebhookSecret returns a 32-char hex string', () => {
    const secret = generateWebhookSecret()
    expect(secret).toMatch(/^[a-f0-9]{64}$/) // 32 bytes = 64 hex chars
  })

  it('encrypts and decrypts a secret round-trip', () => {
    const secret = generateWebhookSecret()
    const encrypted = encryptSecret(secret)
    expect(encrypted).not.toBe(secret)
    const decrypted = decryptSecret(encrypted)
    expect(decrypted).toBe(secret)
  })

  it('HMAC signs and verifies a payload', () => {
    const secret = 'test-secret'
    const body = '{"id":"evt_1","channel":"feeds"}'
    const signature = signWebhookPayload(body, secret)
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true)
  })

  it('rejects tampered payload', () => {
    const secret = 'test-secret'
    const body = '{"id":"evt_1"}'
    const signature = signWebhookPayload(body, secret)
    expect(verifyWebhookSignature('{"id":"evt_2"}', signature, secret)).toBe(false)
  })
})

describe('SSRF validation', () => {
  it('accepts valid HTTPS URL', () => {
    expect(validateWebhookUrl('https://example.com/webhook')).toEqual({ valid: true })
  })

  it('rejects HTTP URL', () => {
    const result = validateWebhookUrl('http://example.com/webhook')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('HTTPS')
  })

  it('rejects localhost', () => {
    const result = validateWebhookUrl('https://localhost/webhook')
    expect(result.valid).toBe(false)
  })

  it('rejects private IP 10.x', () => {
    const result = validateWebhookUrl('https://10.0.0.1/webhook')
    expect(result.valid).toBe(false)
  })

  it('rejects private IP 192.168.x', () => {
    const result = validateWebhookUrl('https://192.168.1.1/webhook')
    expect(result.valid).toBe(false)
  })

  it('rejects private IP 172.16.x', () => {
    const result = validateWebhookUrl('https://172.16.0.1/webhook')
    expect(result.valid).toBe(false)
  })

  it('rejects 127.0.0.1', () => {
    const result = validateWebhookUrl('https://127.0.0.1/webhook')
    expect(result.valid).toBe(false)
  })
})
