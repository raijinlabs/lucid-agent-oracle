import {
  AttestationService,
  type ReportPayload,
  type ReportEnvelope,
  type PublishedFeedRow,
  type OracleClickHouse,
  type PublicationRequest,
  RedpandaProducer,
  TOPICS,
  V1_FEEDS,
  type FeedId,
  computeConfidence,
  computeFreshnessScore,
  computeStalenessRisk,
} from '@lucid/oracle-core'
import type { WorkerConfig } from './config.js'

export interface PublishContext {
  feedId: string
  newValue: number
  previousValue: number | null
  thresholdBps: number
  lastPublishedAt: number | null
  heartbeatIntervalMs: number
  now: number
}

/** Determine if a feed value should be published. */
export function shouldPublish(ctx: PublishContext): boolean {
  if (ctx.previousValue === null || ctx.lastPublishedAt === null) return true
  if (ctx.now - ctx.lastPublishedAt >= ctx.heartbeatIntervalMs) return true
  const deviation = Math.abs(ctx.newValue - ctx.previousValue) / Math.max(ctx.previousValue, 1) * 10000
  return deviation > ctx.thresholdBps
}

export interface FeedComputeResult {
  feedId: FeedId
  valueJson: string
  valueUsd: number | null
  valueIndex: number | null
  inputManifestHash: string
  computationHash: string
  completeness: number
  freshnessMs: number
}

/** Attest, persist to ClickHouse, publish to INDEX_UPDATES + PUBLICATION. */
export async function publishFeedValue(
  result: FeedComputeResult,
  attestation: AttestationService,
  clickhouse: OracleClickHouse,
  producer: RedpandaProducer,
  config: WorkerConfig,
): Promise<void> {
  const now = new Date()
  const def = V1_FEEDS[result.feedId]

  // Compute real confidence using the versioned formula
  const confidence = computeConfidence({
    source_diversity_score: result.completeness,
    identity_confidence: 1.0,
    data_completeness: result.completeness,
    anomaly_cleanliness: 1.0,
    freshness_score: computeFreshnessScore(result.freshnessMs, def.update_interval_ms),
    revision_stability: 1.0,
  })

  const payload: ReportPayload = {
    feed_id: result.feedId,
    feed_version: def.version,
    report_timestamp: now.getTime(),
    values: JSON.parse(result.valueJson),
    input_manifest_hash: result.inputManifestHash,
    computation_hash: result.computationHash,
    revision: 0,
  }

  const envelope: ReportEnvelope = attestation.signReport(payload)

  const row: PublishedFeedRow = {
    feed_id: result.feedId,
    feed_version: def.version,
    computed_at: now.toISOString().replace('T', ' ').replace('Z', ''),
    revision: 0,
    pub_status_rev: 0,
    value_json: result.valueJson,
    value_usd: result.valueUsd,
    value_index: result.valueIndex,
    confidence,
    completeness: result.completeness,
    freshness_ms: result.freshnessMs,
    staleness_risk: computeStalenessRisk(result.freshnessMs, def.update_interval_ms),
    revision_status: 'preliminary',
    methodology_version: def.version,
    input_manifest_hash: result.inputManifestHash,
    computation_hash: result.computationHash,
    signer_set_id: envelope.signer_set_id,
    signatures_json: JSON.stringify(envelope.signatures),
    source_coverage: JSON.stringify(['lucid_gateway']),
    published_solana: null,
    published_base: null,
  }

  // Persist to ClickHouse (source of truth)
  await clickhouse.insertPublishedFeedValue(row)

  // Fanout to API cache
  await producer.publishJson(TOPICS.INDEX_UPDATES, result.feedId, row)

  // Fanout to publisher service for on-chain posting
  const publicationRequest: PublicationRequest = {
    feed_id: result.feedId,
    feed_version: def.version,
    computed_at: now.toISOString().replace('T', ' ').replace('Z', ''),
    revision: 0,
    value_json: result.valueJson,
    value_usd: result.valueUsd,
    value_index: result.valueIndex,
    confidence,
    completeness: result.completeness,
    input_manifest_hash: result.inputManifestHash,
    computation_hash: result.computationHash,
    methodology_version: def.version,
    signer_set_id: envelope.signer_set_id,
    signatures_json: JSON.stringify(envelope.signatures),
  }

  await producer.publishJson(TOPICS.PUBLICATION, result.feedId, publicationRequest)
}
