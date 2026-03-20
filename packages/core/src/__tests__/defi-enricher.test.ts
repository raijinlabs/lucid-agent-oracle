import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enrichDefiPositions } from '../adapters/defi-enricher.js'

function mockPool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  }
  return {
    connect: vi.fn().mockResolvedValue(client),
    _client: client,
  }
}

const BASE_CONFIG = {
  apiKey: 'test-moralis-key',
  intervalMs: 30 * 60_000,
  batchSize: 10,
}

describe('DeFi Position Enricher', () => {
  let pool: ReturnType<typeof mockPool>

  beforeEach(() => {
    pool = mockPool()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('skips when no wallets are found', async () => {
    // Lock acquired
    pool._client.query.mockResolvedValueOnce({
      rows: [{ pg_try_advisory_lock: true }],
    })

    // No wallets
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    // Unlock
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    const result = await enrichDefiPositions(pool as any, BASE_CONFIG)
    expect(result).toBe(0)
    expect(pool._client.release).toHaveBeenCalled()
  })

  it('processes wallets and upserts DeFi positions', async () => {
    // Lock acquired
    pool._client.query.mockResolvedValueOnce({
      rows: [{ pg_try_advisory_lock: true }],
    })

    // Wallets to enrich
    pool._client.query.mockResolvedValueOnce({
      rows: [
        { agent_entity: 'ae_test_1', chain: 'base', address: '0xABCDEF1234567890' },
      ],
    })

    // Mock fetch — Moralis DeFi response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: [
          {
            protocol_name: 'Aerodrome',
            protocol_id: 'aerodrome',
            position: {
              label: 'Liquidity Pool',
              tokens: [
                { symbol: 'USDC', address: '0xusdc', balance_formatted: '100.5', usd_value: 100.5 },
                { symbol: 'WETH', address: '0xweth', balance_formatted: '0.05', usd_value: 150.0 },
              ],
              total_usd_value: 250.5,
            },
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    // Upsert queries (one per token)
    pool._client.query.mockResolvedValueOnce({ rows: [] })
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    // Unlock
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    const result = await enrichDefiPositions(pool as any, BASE_CONFIG)
    expect(result).toBe(2) // 2 tokens upserted
    expect(pool._client.release).toHaveBeenCalled()

    // Check upsert was called with correct data
    const insertCall = pool._client.query.mock.calls[2]
    expect(insertCall[0]).toContain('INSERT INTO oracle_defi_positions')
    expect(insertCall[1]).toContain('ae_test_1')
    expect(insertCall[1]).toContain('Aerodrome')
    expect(insertCall[1]).toContain('lp')

    vi.unstubAllGlobals()
  })

  it('handles Moralis API errors gracefully', async () => {
    // Lock acquired
    pool._client.query.mockResolvedValueOnce({
      rows: [{ pg_try_advisory_lock: true }],
    })

    // Wallets to enrich
    pool._client.query.mockResolvedValueOnce({
      rows: [
        { agent_entity: 'ae_test_fail', chain: 'base', address: '0xFAIL1234567890' },
      ],
    })

    // Mock fetch — failure
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    })
    vi.stubGlobal('fetch', mockFetch)

    // Unlock
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    const result = await enrichDefiPositions(pool as any, BASE_CONFIG)
    expect(result).toBe(0)
    expect(pool._client.release).toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('advisory lock prevents concurrent runs', async () => {
    pool._client.query.mockResolvedValueOnce({
      rows: [{ pg_try_advisory_lock: false }],
    })

    const result = await enrichDefiPositions(pool as any, BASE_CONFIG)
    expect(result).toBe(0)
    expect(pool._client.release).toHaveBeenCalled()
  })

  it('returns 0 when apiKey is empty', async () => {
    const result = await enrichDefiPositions(pool as any, { ...BASE_CONFIG, apiKey: '' })
    expect(result).toBe(0)
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('always releases client even on error', async () => {
    pool._client.query.mockRejectedValueOnce(new Error('DB error'))

    await expect(enrichDefiPositions(pool as any, BASE_CONFIG)).rejects.toThrow('DB error')
    expect(pool._client.release).toHaveBeenCalled()
  })
})
