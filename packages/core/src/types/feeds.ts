import type { QualityEnvelope } from './quality.js'

/** Feed definition — describes a computed oracle index.
 *  Stored in both Postgres (oracle_feed_definitions) and code (V1_FEEDS). */
export interface FeedDefinition {
  /** Unique feed identifier */
  id: FeedId
  /** Schema version for this feed's computation methodology */
  version: number
  /** Human-readable name */
  name: string
  /** What this feed measures */
  description: string
  /** Target update interval in milliseconds */
  update_interval_ms: number
  /** Minimum deviation (in basis points) to trigger a new publication */
  deviation_threshold_bps: number
  /** URL path to the methodology endpoint */
  methodology_url: string
}

/** V1 feed identifiers */
export type FeedId = 'aegdp' | 'aai' | 'apri'

/** Computed feed value before on-chain publication */
export interface FeedValue {
  feed_id: FeedId
  /** String-encoded numeric value (precision-safe) */
  value: string
  /** When this value was computed */
  timestamp: Date
  /** Quality metadata for this computation */
  quality: QualityEnvelope
  /** SHA-256 hash of the computation source code version */
  computation_hash: string
  /** SHA-256 hash of the canonical input data */
  input_manifest_hash: string
}

/** Published feed value with cryptographic attestation */
export interface PublishedFeedValue {
  feed_id: FeedId
  /** String-encoded numeric value */
  value: string
  /** Confidence score from quality envelope */
  confidence: number
  /** Data completeness ratio */
  completeness: number
  /** Freshness of input data in milliseconds */
  freshness_ms: number
  /** Staleness risk assessment */
  staleness_risk: 'low' | 'medium' | 'high'
  /** ISO 8601 timestamp of computation */
  computed_at: string
  /** Hex-encoded Ed25519 public key of the signer */
  signer: string
  /** Hex-encoded Ed25519 signature */
  signature: string
}

/** V1 feed definitions — the three initial oracle indexes */
export const V1_FEEDS: Record<FeedId, FeedDefinition> = {
  aegdp: {
    id: 'aegdp',
    version: 1,
    name: 'Agent Economy GDP',
    description: 'Total economic output across all indexed protocols',
    update_interval_ms: 300_000,
    deviation_threshold_bps: 100,
    methodology_url: '/v1/oracle/feeds/aegdp/methodology',
  },
  aai: {
    id: 'aai',
    version: 1,
    name: 'Agent Activity Index',
    description: 'Dimensionless activity index [0,1000] from active agents, throughput, authentic tool calls, and model-provider diversity',
    update_interval_ms: 300_000,
    deviation_threshold_bps: 200,
    methodology_url: '/v1/oracle/feeds/aai/methodology',
  },
  apri: {
    id: 'apri',
    version: 1,
    name: 'Agent Protocol Risk Index',
    description: 'Risk score [0,10000] bps from error rate, provider concentration (HHI), authenticity ratio, and activity continuity',
    update_interval_ms: 300_000,
    deviation_threshold_bps: 500,
    methodology_url: '/v1/oracle/feeds/apri/methodology',
  },
}
