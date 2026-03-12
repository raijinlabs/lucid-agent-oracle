import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OracleClickHouse } from '../clients/clickhouse.js'

// Shared mock function refs — declared before vi.mock so they are accessible in tests
const mockQuery = vi.fn()
const mockInsert = vi.fn()
const mockPing = vi.fn().mockResolvedValue({ success: true })
const mockClose = vi.fn()

// Mock @clickhouse/client
vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    insert: mockInsert,
    ping: mockPing,
    close: mockClose,
  })),
}))

describe('OracleClickHouse', () => {
  let ch: OracleClickHouse

  beforeEach(() => {
    vi.clearAllMocks()
    // Re-apply default mock for ping after clearAllMocks
    mockPing.mockResolvedValue({ success: true })
    // Default query mock returns empty result set
    mockQuery.mockResolvedValue({ json: async () => [] })
    ch = new OracleClickHouse({ url: 'http://localhost:8123' })
  })

  it('constructs with config', () => {
    expect(ch).toBeDefined()
  })

  it('health check calls ping', async () => {
    const result = await ch.healthCheck()
    expect(result).toBe(true)
  })

  it('insertEvents calls insert with correct table', async () => {
    const events = [
      {
        event_id: 'test-id',
        source: 'lucid_gateway',
        source_adapter_ver: 1,
        ingestion_type: 'realtime',
        ingestion_ts: new Date(),
        chain: 'offchain',
        block_number: null,
        tx_hash: null,
        log_index: null,
        event_type: 'llm_inference',
        event_timestamp: new Date(),
        subject_entity_id: null,
        subject_raw_id: 'tenant_abc',
        subject_id_type: 'tenant',
        counterparty_raw_id: null,
        protocol: 'lucid',
        amount: null,
        currency: null,
        usd_value: '0.05',
        tool_name: null,
        model_id: 'gpt-4o',
        provider: 'openai',
        duration_ms: 1200,
        status: 'success',
        quality_score: 1.0,
        economic_authentic: true,
        corrects_event_id: null,
        correction_reason: null,
      },
    ]
    await ch.insertEvents(events as any)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'raw_economic_events' })
    )
  })

  describe('queryWindowAggregates', () => {
    it('calls query with correct SQL and DateTime-formatted params', async () => {
      const from = new Date('2026-03-12T00:00:00Z')
      const to = new Date('2026-03-12T01:00:00Z')
      await ch.queryWindowAggregates(from, to)
      expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
        query_params: expect.objectContaining({
          from: '2026-03-12 00:00:00',
          to: '2026-03-12 01:00:00',
        }),
      }))
    })

    it('includes uniqMerge for unique_providers', async () => {
      const from = new Date('2026-03-12T00:00:00Z')
      const to = new Date('2026-03-12T01:00:00Z')
      await ch.queryWindowAggregates(from, to)
      const call = mockQuery.mock.calls[0][0]
      expect(call.query).toContain('uniqMerge(distinct_providers)')
    })
  })

  describe('queryLatestPublishedValue', () => {
    it('uses FINAL and revision_status filter', async () => {
      await ch.queryLatestPublishedValue('aegdp', 1)
      const call = mockQuery.mock.calls[0][0]
      expect(call.query).toContain('FINAL')
      expect(call.query).toContain("revision_status != 'superseded'")
    })
  })
})
