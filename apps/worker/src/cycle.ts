import type pg from 'pg'
import {
  OracleClickHouse,
  RedpandaProducer,
  AttestationService,
  V1_FEEDS,
  computeAEGDP,
  computeAAI,
  computeAPRI,
  type FeedId,
} from '@lucid/oracle-core'
import type { WorkerConfig } from './config.js'
import { CheckpointManager } from './checkpoint.js'
import { pollAllTables } from './poller.js'
import { buildAEGDPInputs, buildAAIInputs, buildAPRIInputs } from './compute.js'
import { shouldPublish, publishFeedValue, type FeedComputeResult } from './publisher.js'

// Track last publish time per feed (in-memory, seeded from ClickHouse on first cycle)
const lastPublishTime = new Map<string, number>()

/** Seed lastPublishTime from ClickHouse — call once before first cycle. */
export async function seedLastPublishTimes(clickhouse: OracleClickHouse): Promise<void> {
  for (const def of Object.values(V1_FEEDS)) {
    const prev = await clickhouse.queryLatestPublishedValue(def.id, def.version)
    if (prev) {
      lastPublishTime.set(def.id, new Date(prev.computed_at).getTime())
    }
  }
}

export async function runCycle(
  config: WorkerConfig,
  clickhouse: OracleClickHouse,
  producer: RedpandaProducer,
  attestation: AttestationService,
  checkpointMgr: CheckpointManager,
  pool: pg.Pool,
): Promise<void> {
  const now = Date.now()
  const windowMs = config.computationWindowMs
  const windowSeconds = windowMs / 1000
  const from = new Date(now - windowMs)
  const to = new Date(now)

  // 1. Poll gateway tables
  const checkpoints = await checkpointMgr.loadAll()
  const { events, updates } = await pollAllTables(pool, checkpoints)

  // 2. Ingest into ClickHouse
  if (events.length > 0) {
    await clickhouse.insertEvents(events)
  }

  // 3. Advance checkpoints
  for (const u of updates) {
    await checkpointMgr.advance(u.table, u.ts, u.id)
  }

  // 4. Compute feeds
  const [windowAgg, protocolUsd, activeBuckets, providerCounts] = await Promise.all([
    clickhouse.queryWindowAggregates(from, to),
    clickhouse.queryProtocolUsdBreakdown(from, to),
    clickhouse.queryActiveBucketCount(from, to),
    clickhouse.queryProviderEventCounts(from, to),
  ])

  const totalBuckets = Math.floor(windowMs / 60000)
  const hasData = windowAgg.total_events > 0
  const completeness = hasData ? 1.0 : 0.0

  // AEGDP
  const aegdpInputs = buildAEGDPInputs(protocolUsd)
  const aegdpResult = computeAEGDP(aegdpInputs)

  // AAI
  const aaiInputs = buildAAIInputs(windowAgg, windowSeconds)
  const aaiResult = computeAAI(aaiInputs)

  // APRI
  const apriInputs = buildAPRIInputs(windowAgg, providerCounts, activeBuckets, totalBuckets)
  const apriResult = computeAPRI(apriInputs)

  // 5. Threshold check + publish
  const feedResults: FeedComputeResult[] = [
    {
      feedId: 'aegdp',
      valueJson: JSON.stringify({ value_usd: aegdpResult.value_usd, breakdown: aegdpResult.breakdown }),
      valueUsd: aegdpResult.value_usd,
      valueIndex: null,
      inputManifestHash: aegdpResult.input_manifest_hash,
      computationHash: aegdpResult.computation_hash,
      completeness,
    },
    {
      feedId: 'aai',
      valueJson: JSON.stringify({ value: aaiResult.value, breakdown: aaiResult.breakdown }),
      valueUsd: null,
      valueIndex: aaiResult.value,
      inputManifestHash: aaiResult.input_manifest_hash,
      computationHash: aaiResult.computation_hash,
      completeness,
    },
    {
      feedId: 'apri',
      valueJson: JSON.stringify({ value: apriResult.value, breakdown: apriResult.breakdown }),
      valueUsd: null,
      valueIndex: apriResult.value,
      inputManifestHash: apriResult.input_manifest_hash,
      computationHash: apriResult.computation_hash,
      completeness,
    },
  ]

  for (const result of feedResults) {
    const def = V1_FEEDS[result.feedId]
    const prev = await clickhouse.queryLatestPublishedValue(result.feedId, def.version)
    const prevValue = prev ? (prev.value_usd ?? prev.value_index ?? 0) : null
    const newValue = result.valueUsd ?? result.valueIndex ?? 0

    if (shouldPublish({
      feedId: result.feedId,
      newValue,
      previousValue: prevValue,
      thresholdBps: def.deviation_threshold_bps,
      lastPublishedAt: lastPublishTime.get(result.feedId) ?? null,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      now,
    })) {
      await publishFeedValue(result, attestation, clickhouse, producer, config)
      lastPublishTime.set(result.feedId, now)
    }
  }
}
