import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock redis module before imports
const mockClient = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  quit: vi.fn(),
  duplicate: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  xAdd: vi.fn().mockResolvedValue('1710547200000-0'),
  incr: vi.fn().mockResolvedValue(1),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  on: vi.fn(),
  get: vi.fn(),
  multi: vi.fn(),
  isOpen: true,
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
}))

vi.mock('../services/agent-query.js', () => ({
  PROTOCOL_REGISTRY: {},
}))

describe('Redis SSE/Webhook helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.duplicate.mockReturnValue({
      ...mockClient,
      connect: vi.fn(),
      quit: vi.fn(),
    })
  })

  it('publishEvent publishes JSON to oracle:events:{channel}', async () => {
    const { publishEvent, initRedis } = await import('../services/redis.js')
    await initRedis('redis://localhost:6379')

    await publishEvent('feeds', { feedId: 'aegdp', value: 142.7 })

    expect(mockClient.publish).toHaveBeenCalledWith(
      'oracle:events:feeds',
      expect.any(String),
    )
    const payload = JSON.parse(mockClient.publish.mock.calls[0][1])
    expect(payload.feedId).toBe('aegdp')
  })

  it('enqueueWebhook XADDs to oracle:webhooks stream', async () => {
    const { enqueueWebhook, initRedis } = await import('../services/redis.js')
    await initRedis('redis://localhost:6379')

    await enqueueWebhook('feeds', { feedId: 'aegdp', value: 152.3 })

    expect(mockClient.xAdd).toHaveBeenCalledWith(
      'oracle:webhooks',
      '*',
      expect.objectContaining({ channel: 'feeds' }),
    )
  })

  it('nextEventId returns monotonic {timestamp}-{seq}', async () => {
    const { nextEventId, initRedis } = await import('../services/redis.js')
    await initRedis('redis://localhost:6379')

    mockClient.incr.mockResolvedValue(42)
    const id = await nextEventId()

    expect(id).toMatch(/^\d+-42$/)
    expect(mockClient.incr).toHaveBeenCalledWith('oracle:event_seq')
  })
})
