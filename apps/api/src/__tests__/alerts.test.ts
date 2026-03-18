import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock crypto utils
vi.mock('../utils/crypto.js', () => ({
  generateWebhookSecret: vi.fn(() => 'aaaa'.repeat(16)),
  encryptSecret: vi.fn((s: string) => `encrypted:${s}`),
  validateWebhookUrl: vi.fn(() => ({ valid: true })),
}))

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

describe('Alert routes logic', () => {
  let db: ReturnType<typeof mockDb>

  beforeEach(() => {
    vi.clearAllMocks()
    db = mockDb()
    vi.stubEnv('WEBHOOK_SECRET_KEY', 'a]32-byte-key-for-aes-256-gcm!!')
  })

  it('create inserts subscription with encrypted secret', async () => {
    const { createAlert } = await import('../routes/alerts.js')

    db.query.mockResolvedValueOnce({ rows: [{ count: '0' }] }) // count check
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sub_1' }] }) // insert

    const result = await createAlert(db as any, {
      tenantId: 'tenant_1',
      plan: 'pro',
      body: {
        channel: 'feeds',
        url: 'https://example.com/webhook',
      },
    })

    expect(result.error).toBeUndefined()
    expect(result.subscription).toBeDefined()
    expect(result.secret).toBe('aaaa'.repeat(16))

    // Verify insert query includes encrypted secret
    const insertCall = db.query.mock.calls[1]
    expect(insertCall[0]).toContain('INSERT INTO oracle_subscriptions')
    expect(insertCall[1]).toContain('encrypted:' + 'aaaa'.repeat(16))
  })

  it('create rejects non-HTTPS URL', async () => {
    const { validateWebhookUrl } = await import('../utils/crypto.js')
    vi.mocked(validateWebhookUrl).mockReturnValue({ valid: false, error: 'HTTPS required' })

    const { createAlert } = await import('../routes/alerts.js')

    const result = await createAlert(db as any, {
      tenantId: 'tenant_1',
      plan: 'pro',
      body: {
        channel: 'feeds',
        url: 'http://example.com/webhook',
      },
    })

    expect(result.error).toContain('HTTPS')
    expect(result.status).toBe(400)
  })

  it('create enforces subscription limit', async () => {
    const { validateWebhookUrl } = await import('../utils/crypto.js')
    vi.mocked(validateWebhookUrl).mockReturnValue({ valid: true })

    const { createAlert } = await import('../routes/alerts.js')

    db.query.mockResolvedValueOnce({ rows: [{ count: '10' }] }) // at limit

    const result = await createAlert(db as any, {
      tenantId: 'tenant_1',
      plan: 'pro',
      body: {
        channel: 'feeds',
        url: 'https://example.com/webhook',
      },
    })

    expect(result.error).toContain('limit')
    expect(result.status).toBe(429)
  })

  it('list returns active subscriptions for tenant', async () => {
    const { listAlerts } = await import('../routes/alerts.js')

    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'sub_1',
        channel: 'feeds',
        webhook_url: 'https://example.com/wh',
        filter_json: null,
        conditions_json: null,
        active: true,
        created_at: '2026-03-16T00:00:00Z',
      }],
    })

    const result = await listAlerts(db as any, 'tenant_1')
    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe('sub_1')
  })

  it('delete sets active = false', async () => {
    const { deleteAlert } = await import('../routes/alerts.js')

    db.query.mockResolvedValueOnce({ rows: [{ id: 'sub_1' }] }) // found

    const result = await deleteAlert(db as any, 'sub_1', 'tenant_1')
    expect(result.error).toBeUndefined()

    const deleteCall = db.query.mock.calls[0]
    expect(deleteCall[0]).toContain('UPDATE oracle_subscriptions')
    expect(deleteCall[0]).toContain('active = false')
  })

  it('delete returns 404 for non-existent subscription', async () => {
    const { deleteAlert } = await import('../routes/alerts.js')

    db.query.mockResolvedValueOnce({ rows: [] }) // not found

    const result = await deleteAlert(db as any, 'sub_999', 'tenant_1')
    expect(result.status).toBe(404)
  })
})
