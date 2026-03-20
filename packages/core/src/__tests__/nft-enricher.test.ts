import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { enrichNftHoldings } from '../adapters/nft-enricher.js'

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

describe('NFT Holdings Enricher', () => {
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

    const result = await enrichNftHoldings(pool as any, BASE_CONFIG)
    expect(result).toBe(0)
    expect(pool._client.release).toHaveBeenCalled()
  })

  it('processes wallets and upserts NFT holdings', async () => {
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

    // Mock fetch — Moralis NFT response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: [
          {
            token_address: '0xNFTCONTRACT',
            token_id: '123',
            name: 'Cool NFT #123',
            metadata: { name: 'Cool NFT #123', image: 'https://example.com/nft.png' },
            collection_name: 'Cool NFTs',
          },
          {
            token_address: '0xNFTCONTRACT2',
            token_id: '456',
            name: null,
            metadata: '{"name":"Parsed NFT","image":"https://example.com/nft2.png"}',
            collection_name: 'Parsed Collection',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    // Upsert queries (one per NFT)
    pool._client.query.mockResolvedValueOnce({ rows: [] })
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    // Unlock
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    const result = await enrichNftHoldings(pool as any, BASE_CONFIG)
    expect(result).toBe(2) // 2 NFTs upserted
    expect(pool._client.release).toHaveBeenCalled()

    // Check first upsert was called with correct data
    const insertCall = pool._client.query.mock.calls[2]
    expect(insertCall[0]).toContain('INSERT INTO oracle_nft_holdings')
    expect(insertCall[1]).toContain('ae_test_1')
    expect(insertCall[1]).toContain('Cool NFT #123')
    expect(insertCall[1]).toContain('https://example.com/nft.png')

    // Check second upsert parsed string metadata correctly
    const insertCall2 = pool._client.query.mock.calls[3]
    expect(insertCall2[1]).toContain('Parsed NFT')
    expect(insertCall2[1]).toContain('https://example.com/nft2.png')

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

    const result = await enrichNftHoldings(pool as any, BASE_CONFIG)
    expect(result).toBe(0)
    expect(pool._client.release).toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('advisory lock prevents concurrent runs', async () => {
    pool._client.query.mockResolvedValueOnce({
      rows: [{ pg_try_advisory_lock: false }],
    })

    const result = await enrichNftHoldings(pool as any, BASE_CONFIG)
    expect(result).toBe(0)
    expect(pool._client.release).toHaveBeenCalled()
  })

  it('returns 0 when apiKey is empty', async () => {
    const result = await enrichNftHoldings(pool as any, { ...BASE_CONFIG, apiKey: '' })
    expect(result).toBe(0)
    expect(pool.connect).not.toHaveBeenCalled()
  })

  it('always releases client even on error', async () => {
    pool._client.query.mockRejectedValueOnce(new Error('DB error'))

    await expect(enrichNftHoldings(pool as any, BASE_CONFIG)).rejects.toThrow('DB error')
    expect(pool._client.release).toHaveBeenCalled()
  })

  it('handles NFTs with null metadata gracefully', async () => {
    // Lock acquired
    pool._client.query.mockResolvedValueOnce({
      rows: [{ pg_try_advisory_lock: true }],
    })

    // Wallets to enrich
    pool._client.query.mockResolvedValueOnce({
      rows: [
        { agent_entity: 'ae_test_null', chain: 'base', address: '0xNULL1234567890' },
      ],
    })

    // Mock fetch — NFT with null metadata
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        result: [
          {
            token_address: '0xNFTNULL',
            token_id: '789',
            name: 'No Metadata NFT',
            metadata: null,
            collection_name: null,
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    // Upsert query
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    // Unlock
    pool._client.query.mockResolvedValueOnce({ rows: [] })

    const result = await enrichNftHoldings(pool as any, BASE_CONFIG)
    expect(result).toBe(1)

    // Check upsert: name from top-level, image_url null, collection_name null
    const insertCall = pool._client.query.mock.calls[2]
    expect(insertCall[1]).toContain('No Metadata NFT')
    expect(insertCall[1][5]).toBe('No Metadata NFT') // name
    expect(insertCall[1][6]).toBeNull() // image_url
    expect(insertCall[1][7]).toBeNull() // collection_name

    vi.unstubAllGlobals()
  })
})
