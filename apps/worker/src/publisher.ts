import {
  AttestationService,
  type ReportPayload,
  type ReportEnvelope,
  type PublishedFeedRow,
  type OracleClickHouse,
  RedpandaProducer,
  TOPICS,
  V1_FEEDS,
  type FeedId,
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
  // Always publish first value
  if (ctx.previousValue === null || ctx.lastPublishedAt === null) return true

  // Heartbeat: publish if enough time elapsed
  if (ctx.now - ctx.lastPublishedAt >= ctx.heartbeatIntervalMs) return true

  // Deviation: |new - old| / max(old, 1) * 10000 > threshold
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
}

/** Attest, persist to ClickHouse, and fanout to Redpanda. */
export async function publishFeedValue(
  result: FeedComputeResult,
  attestation: AttestationService,
  clickhouse: OracleClickHouse,
  producer: RedpandaProducer,
  config: WorkerConfig,
): Promise<void> {
  const now = new Date()
  const def = V1_FEEDS[result.feedId]

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
    computed_at: now.toISOString(),
    revision: 0,
    value_json: result.valueJson,
    value_usd: result.valueUsd,
    value_index: result.valueIndex,
    confidence: result.completeness,
    completeness: result.completeness,
    freshness_ms: 0,
    staleness_risk: 'low',
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

  // Fanout to Redpanda
  await producer.publishJson(TOPICS.INDEX_UPDATES, result.feedId, row)
}
