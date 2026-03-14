import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { RawEconomicEvent } from '../types/events.js'

export interface ClickHouseConfig {
  url: string
  username?: string
  password?: string
  database?: string
}

/** Aggregate totals for the computation window (one row). */
export interface WindowAggregates {
  total_events: number
  total_authentic: number
  total_usd: number
  total_success: number
  total_errors: number
  authentic_operational: number
  authentic_tool_calls: number
  total_operational: number
  operational_errors: number
  unique_agents_authentic: number
  unique_model_provider_pairs_authentic: number
  unique_providers: number
}

/** Per-protocol per-event-type USD breakdown for AEGDP. */
export interface ProtocolUsdRow {
  protocol: string
  event_type: string
  usd_value: number
}

/** Provider event counts for HHI calculation. */
export interface ProviderCountRow {
  provider: string
  cnt: number
}

/** Full published_feed_values row matching ClickHouse schema. */
export interface PublishedFeedRow {
  feed_id: string
  feed_version: number
  computed_at: string
  revision: number
  pub_status_rev: number
  value_json: string
  value_usd: number | null
  value_index: number | null
  confidence: number
  completeness: number
  freshness_ms: number
  staleness_risk: string
  revision_status: string
  methodology_version: number
  input_manifest_hash: string
  computation_hash: string
  signer_set_id: string
  signatures_json: string
  source_coverage: string
  published_solana: string | null
  published_base: string | null
}

/** Format Date as ClickHouse DateTime string (YYYY-MM-DD HH:MM:SS). */
function toClickHouseDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

export class OracleClickHouse {
  private readonly client: ClickHouseClient

  constructor(config: ClickHouseConfig) {
    this.client = createClient({
      url: config.url,
      username: config.username ?? 'default',
      password: config.password ?? '',
      database: config.database ?? 'oracle_economy',
    })
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.client.ping()
    return result.success
  }

  async insertEvents(events: RawEconomicEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.client.insert({
      table: 'raw_economic_events',
      values: events.map((e) => ({
        ...e,
        ingestion_ts: e.ingestion_ts.toISOString(),
        event_timestamp: e.event_timestamp.toISOString(),
        economic_authentic: e.economic_authentic ? 1 : 0,
      })),
      format: 'JSONEachRow',
    })
  }

  /**
   * Global window aggregates from metric_rollups_1m for AAI/APRI computation.
   */
  async queryWindowAggregates(from: Date, to: Date): Promise<WindowAggregates> {
    const result = await this.client.query({
      query: `
        SELECT
          sum(event_count) AS total_events,
          sum(authentic_count) AS total_authentic,
          sum(total_usd_value) AS total_usd,
          sum(success_count) AS total_success,
          sum(error_count) AS total_errors,
          sumIf(authentic_count, event_type IN ('llm_inference', 'tool_call')) AS authentic_operational,
          sumIf(authentic_count, event_type = 'tool_call') AS authentic_tool_calls,
          sumIf(event_count, event_type IN ('llm_inference', 'tool_call')) AS total_operational,
          sumIf(error_count, event_type IN ('llm_inference', 'tool_call')) AS operational_errors,
          uniqMerge(distinct_subjects_authentic) AS unique_agents_authentic,
          uniqMerge(distinct_model_provider_pairs_authentic) AS unique_model_provider_pairs_authentic,
          uniqMerge(distinct_providers) AS unique_providers
        FROM metric_rollups_1m
        WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Record<string, string>[]
    const row = rows[0]
    if (!row) {
      return {
        total_events: 0, total_authentic: 0, total_usd: 0,
        total_success: 0, total_errors: 0, authentic_operational: 0,
        authentic_tool_calls: 0, total_operational: 0, operational_errors: 0,
        unique_agents_authentic: 0, unique_model_provider_pairs_authentic: 0,
        unique_providers: 0,
      }
    }
    return {
      total_events: Number(row.total_events),
      total_authentic: Number(row.total_authentic),
      total_usd: Number(row.total_usd),
      total_success: Number(row.total_success),
      total_errors: Number(row.total_errors),
      authentic_operational: Number(row.authentic_operational),
      authentic_tool_calls: Number(row.authentic_tool_calls),
      total_operational: Number(row.total_operational),
      operational_errors: Number(row.operational_errors),
      unique_agents_authentic: Number(row.unique_agents_authentic),
      unique_model_provider_pairs_authentic: Number(row.unique_model_provider_pairs_authentic),
      unique_providers: Number(row.unique_providers),
    }
  }

  /** Per-protocol per-event-type USD breakdown for AEGDP. */
  async queryProtocolUsdBreakdown(from: Date, to: Date): Promise<ProtocolUsdRow[]> {
    const result = await this.client.query({
      query: `
        SELECT protocol, event_type, sum(total_usd_value) AS usd_value
        FROM metric_rollups_1m
        WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
        GROUP BY protocol, event_type
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ protocol: string; event_type: string; usd_value: string }>
    return rows.map((r) => ({ protocol: r.protocol, event_type: r.event_type, usd_value: Number(r.usd_value) }))
  }

  /** Count of 1-min buckets with at least one event (for APRI activity_continuity). */
  async queryActiveBucketCount(from: Date, to: Date): Promise<number> {
    const result = await this.client.query({
      query: `
        SELECT count() AS active_buckets FROM (
          SELECT bucket
          FROM metric_rollups_1m
          WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
          GROUP BY bucket
          HAVING sum(event_count) > 0
        )
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ active_buckets: string }>
    return Number(rows[0]?.active_buckets ?? 0)
  }

  /** Per-provider event counts from raw events for APRI HHI (not from rollups). */
  async queryProviderEventCounts(from: Date, to: Date): Promise<ProviderCountRow[]> {
    const result = await this.client.query({
      query: `
        SELECT provider, count() AS cnt
        FROM raw_economic_events
        WHERE event_timestamp >= {from:DateTime} AND event_timestamp < {to:DateTime}
          AND event_type IN ('llm_inference', 'tool_call')
          AND provider IS NOT NULL
          AND corrects_event_id IS NULL
        GROUP BY provider
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ provider: string; cnt: string }>
    return rows.map((r) => ({ provider: r.provider, cnt: Number(r.cnt) }))
  }

  /** Latest non-superseded published value for a feed. Uses FINAL for dedup. */
  async queryLatestPublishedValue(feedId: string, feedVersion: number): Promise<PublishedFeedRow | null> {
    const result = await this.client.query({
      query: `
        SELECT *
        FROM published_feed_values FINAL
        WHERE feed_id = {feedId:String}
          AND feed_version = {feedVersion:UInt16}
          AND revision_status != 'superseded'
        ORDER BY computed_at DESC
        LIMIT 1
      `,
      query_params: { feedId, feedVersion },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as PublishedFeedRow[]
    return rows[0] ?? null
  }

  /** Insert a published feed value. */
  async insertPublishedFeedValue(row: PublishedFeedRow): Promise<void> {
    await this.client.insert({
      table: 'published_feed_values',
      values: [row],
      format: 'JSONEachRow',
    })
  }

  /** Check publication status for a specific feed value (idempotency check).
   *  Returns pub_status_rev so callers can increment it for the next status row. */
  async queryPublicationStatus(
    feedId: string,
    feedVersion: number,
    computedAt: string,
    revision: number,
  ): Promise<{ published_solana: string | null; published_base: string | null; pub_status_rev: number } | null> {
    const result = await this.client.query({
      query: `
        SELECT published_solana, published_base, pub_status_rev
        FROM published_feed_values FINAL
        WHERE feed_id = {feedId:String}
          AND feed_version = {feedVersion:UInt16}
          AND computed_at = {computedAt:String}
          AND revision = {revision:UInt16}
        ORDER BY pub_status_rev DESC
        LIMIT 1
      `,
      query_params: { feedId, feedVersion, computedAt, revision },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ published_solana: string | null; published_base: string | null; pub_status_rev: number }>
    return rows[0] ?? null
  }

  // ---------------------------------------------------------------------------
  // Plan 3B: Interval/period whitelist for safe SQL interpolation
  // ---------------------------------------------------------------------------

  private static readonly INTERVAL_SQL: Record<string, string> = {
    '1m': 'INTERVAL 1 MINUTE',
    '1h': 'INTERVAL 1 HOUR',
    '1d': 'INTERVAL 1 DAY',
  }

  private static readonly PERIOD_SQL: Record<string, string> = {
    '1d': 'INTERVAL 1 DAY',
    '7d': 'INTERVAL 7 DAY',
    '30d': 'INTERVAL 30 DAY',
    '90d': 'INTERVAL 90 DAY',
  }

  /** Map user-facing interval string to safe SQL literal. Throws on invalid input. */
  private static toIntervalSql(interval: string): string {
    const sql = OracleClickHouse.INTERVAL_SQL[interval]
    if (!sql) throw new Error(`Invalid interval: ${interval}`)
    return sql
  }

  /** Map user-facing period string to safe SQL literal. Throws on invalid input. */
  private static toPeriodSql(period: string): string {
    const sql = OracleClickHouse.PERIOD_SQL[period]
    if (!sql) throw new Error(`Invalid period: ${period}`)
    return sql
  }

  // ---------------------------------------------------------------------------
  // Plan 3B: Feed history time-series
  // ---------------------------------------------------------------------------

  /** Time-series feed values bucketed by interval. */
  async queryFeedHistory(
    feedId: string,
    feedVersion: number,
    period: string,
    interval: string,
  ): Promise<Array<{ timestamp: string; value: string; confidence: number }>> {
    const periodSql = OracleClickHouse.toPeriodSql(period)
    const intervalSql = OracleClickHouse.toIntervalSql(interval)

    const result = await this.client.query({
      query: `
        SELECT
          toStartOfInterval(computed_at, ${intervalSql}) AS timestamp,
          argMax(value_json, computed_at) AS value,
          argMax(confidence, computed_at) AS confidence
        FROM published_feed_values
        WHERE feed_id = {feedId:String}
          AND feed_version = {feedVersion:UInt16}
          AND computed_at >= now() - ${periodSql}
        GROUP BY timestamp
        ORDER BY timestamp ASC
      `,
      query_params: { feedId, feedVersion },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ timestamp: string; value: string; confidence: string }>
    return rows.map((r) => ({
      timestamp: r.timestamp,
      value: r.value,
      confidence: Number(r.confidence),
    }))
  }

  // ---------------------------------------------------------------------------
  // Plan 3B: Model usage distribution
  // ---------------------------------------------------------------------------

  /** LLM model/provider distribution from raw economic events. */
  async queryModelUsage(
    period: string,
    limit: number,
  ): Promise<{ models: Array<{ model_id: string; provider: string; event_count: number }>; total_events: number }> {
    const periodSql = OracleClickHouse.toPeriodSql(period)

    const whereClause = `
      event_type = 'llm_inference'
      AND event_timestamp >= now() - ${periodSql}
      AND model_id IS NOT NULL
      AND model_id != ''
    `

    // Two queries: top-N models + true total (independent of LIMIT)
    const [modelsResult, totalResult] = await Promise.all([
      this.client.query({
        query: `
          SELECT model_id, provider, count() AS event_count
          FROM raw_economic_events
          WHERE ${whereClause}
          GROUP BY model_id, provider
          ORDER BY event_count DESC
          LIMIT {limit:UInt32}
        `,
        query_params: { limit },
        format: 'JSONEachRow',
      }),
      this.client.query({
        query: `
          SELECT count() AS total
          FROM raw_economic_events
          WHERE ${whereClause}
        `,
        format: 'JSONEachRow',
      }),
    ])

    const rows = (await modelsResult.json()) as Array<{ model_id: string; provider: string; event_count: string }>
    const totalRows = (await totalResult.json()) as Array<{ total: string }>
    const total_events = Number(totalRows[0]?.total ?? 0)

    const models = rows.map((r) => ({
      model_id: r.model_id,
      provider: r.provider,
      event_count: Number(r.event_count),
    }))
    return { models, total_events }
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
