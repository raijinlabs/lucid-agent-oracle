import type { FeedId } from './feeds.js'

/** Message published to TOPICS.PUBLICATION by the worker.
 *  Typed contract between worker and publisher — deliberately NOT PublishedFeedRow. */
export interface PublicationRequest {
  feed_id: FeedId
  feed_version: number
  computed_at: string // ISO 8601
  revision: number    // 0 = original, 1+ = restatement

  // Value
  value_json: string
  value_usd: number | null
  value_index: number | null

  // Quality
  confidence: number
  completeness: number

  // Provenance
  input_manifest_hash: string
  computation_hash: string
  methodology_version: number

  // Attestation
  signer_set_id: string
  signatures_json: string
}

/** On-chain value encoding: feed-specific scaling to u64 + decimals. */
export interface OnChainValue {
  value: bigint
  decimals: number
}

/** Feed-specific value encoding table.
 *  AEGDP: USD × 10^6 (decimals=6). AAI: index 0-1000 (decimals=0). APRI: bps 0-10000 (decimals=0). */
const ENCODING: Record<FeedId, { decimals: number; field: 'value_usd' | 'value_index' }> = {
  aegdp: { decimals: 6, field: 'value_usd' },
  aai:   { decimals: 0, field: 'value_index' },
  apri:  { decimals: 0, field: 'value_index' },
}

/** Encode a feed value for on-chain storage. */
export function encodeOnChainValue(
  feedId: FeedId,
  valueUsd: number | null,
  valueIndex: number | null,
): OnChainValue {
  const enc = ENCODING[feedId]
  if (!enc) throw new Error(`Unknown feed_id: ${feedId}`)

  const raw = enc.field === 'value_usd' ? valueUsd : valueIndex
  if (raw == null) {
    const label = feedId.toUpperCase()
    throw new Error(`${label} requires ${enc.field}`)
  }

  const scaled = BigInt(Math.round(raw * 10 ** enc.decimals))
  return { value: scaled, decimals: enc.decimals }
}
