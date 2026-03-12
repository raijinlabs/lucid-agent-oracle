import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { postToBase, type BaseClient } from '../base.js'
import type { PublicationRequest } from '@lucid/oracle-core'

const mockRequest: PublicationRequest = {
  feed_id: 'aegdp',
  feed_version: 1,
  computed_at: '2026-03-12T00:00:00.000Z',
  revision: 0,
  value_json: '{"value_usd": 847000}',
  value_usd: 847_000,
  value_index: null,
  confidence: 0.85,
  completeness: 0.8,
  input_manifest_hash: 'abc123',
  computation_hash: 'def456',
  methodology_version: 1,
  signer_set_id: 'ss_lucid_v1',
  signatures_json: '[{"signer":"pub1","sig":"sig1"}]',
}

describe('postToBase', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls writeContract with correct feed encoding', async () => {
    const mockHash = '0xabc123' as `0x${string}`
    const mockReceipt = { transactionHash: mockHash, status: 'success' as const }
    const client: BaseClient = {
      writeContract: vi.fn().mockResolvedValue(mockHash),
      waitForTransactionReceipt: vi.fn().mockResolvedValue(mockReceipt),
    }

    const txHash = await postToBase(client, mockRequest)

    expect(txHash).toBe(mockHash)
    expect(client.writeContract).toHaveBeenCalledOnce()

    const args = (client.writeContract as any).mock.calls[0][0]
    expect(args.functionName).toBe('postReport')
    expect(args.args[1]).toBe(847_000_000_000n)
    expect(args.args[2]).toBe(6)
  })

  it('retries up to 3 times on failure', async () => {
    const client: BaseClient = {
      writeContract: vi.fn()
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockResolvedValueOnce('0xsuccess' as `0x${string}`),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ transactionHash: '0xsuccess', status: 'success' }),
    }

    const promise = postToBase(client, mockRequest)
    await vi.runAllTimersAsync()
    const txHash = await promise
    expect(txHash).toBe('0xsuccess')
    expect(client.writeContract).toHaveBeenCalledTimes(3)
  })

  it('throws after 3 failed attempts', async () => {
    const client: BaseClient = {
      writeContract: vi.fn().mockRejectedValue(new Error('always fails')),
      waitForTransactionReceipt: vi.fn(),
    }

    const resultPromise = postToBase(client, mockRequest).catch((e) => e)
    await vi.runAllTimersAsync()
    const err = await resultPromise
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('always fails')
    expect(client.writeContract).toHaveBeenCalledTimes(3)
  })
})
