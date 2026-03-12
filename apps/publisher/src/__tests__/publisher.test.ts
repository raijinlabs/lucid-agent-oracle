import { describe, it, expect, vi } from 'vitest'
import { handlePublicationRequest } from '../index.js'
import type { PublicationRequest } from '@lucid/oracle-core'

const mockReq: PublicationRequest = {
  feed_id: 'aegdp', feed_version: 1,
  computed_at: '2026-03-12T00:00:00.000Z', revision: 0,
  value_json: '{"value_usd":1000}', value_usd: 1000, value_index: null,
  confidence: 0.85, completeness: 0.8,
  input_manifest_hash: 'abc', computation_hash: 'def',
  methodology_version: 1, signer_set_id: 'ss_lucid_v1', signatures_json: '[]',
}

describe('handlePublicationRequest', () => {
  it('posts to both chains in parallel and records status', async () => {
    const mockSolana = vi.fn().mockResolvedValue('sol_sig_123')
    const mockBase = vi.fn().mockResolvedValue('0xbase_hash_456')
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue(null),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await handlePublicationRequest(mockReq, {
      postSolana: mockSolana,
      postBase: mockBase,
      clickhouse: mockClickhouse as any,
    })

    expect(mockSolana).toHaveBeenCalledWith(mockReq)
    expect(mockBase).toHaveBeenCalledWith(mockReq)
    expect(mockClickhouse.insertPublishedFeedValue).toHaveBeenCalledOnce()
    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    expect(row.published_solana).toBe('sol_sig_123')
    expect(row.published_base).toBe('0xbase_hash_456')
  })

  it('handles partial failure — one chain fails', async () => {
    const mockSolana = vi.fn().mockRejectedValue(new Error('RPC timeout'))
    const mockBase = vi.fn().mockResolvedValue('0xbase_ok')
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue(null),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await handlePublicationRequest(mockReq, {
      postSolana: mockSolana,
      postBase: mockBase,
      clickhouse: mockClickhouse as any,
    })

    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    expect(row.published_solana).toBeNull()
    expect(row.published_base).toBe('0xbase_ok')
  })

  it('skips already-published chains (idempotency)', async () => {
    const mockSolana = vi.fn()
    const mockBase = vi.fn().mockResolvedValue('0xbase_new')
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue({
        published_solana: '0xalready_sol', published_base: null, pub_status_rev: 1,
      }),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await handlePublicationRequest(mockReq, {
      postSolana: mockSolana,
      postBase: mockBase,
      clickhouse: mockClickhouse as any,
    })

    expect(mockSolana).not.toHaveBeenCalled()
    expect(mockBase).toHaveBeenCalledOnce()
  })
})
