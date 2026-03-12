import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { RawEconomicEvent } from '../types/events.js'

/** ClickHouse connection configuration */
export interface ClickHouseConfig {
  url: string
  username?: string
  password?: string
  database?: string
}

/** Typed result row from metric_rollups_1m aggregation */
export interface RollupRow {
  bucket: string
  total_authentic: string
  total_usd: string
  total_events: string
  total_success: string
  total_errors: string
}

/** Typed result row from published_feed_values */
export interface StoredFeedValue {
  feed_id: string
  computed_at: string
  value: string
  confidence: number
  completeness: number
  freshness_ms: number
  signer: string
  signature: string
}

/**
 * ClickHouse client wrapper for the Oracle Economy data plane.
 * Provides typed methods for event ingestion and feed value queries.
 */
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

  /** Health check — pings the ClickHouse server */
  async healthCheck(): Promise<boolean> {
    const result = await this.client.ping()
    return result.success
  }

  /** Insert raw economic events into ClickHouse */
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

  /** Query aggregated rollup data for a feed */
  async queryFeedRollup(
    feedId: string,
    fromMinute: Date,
    toMinute: Date,
  ): Promise<RollupRow[]> {
    const result = await this.client.query({
      query: `
        SELECT
          bucket,
          sum(authentic_count) AS total_authentic,
          sum(total_usd_value) AS total_usd,
          sum(event_count) AS total_events,
          sum(success_count) AS total_success,
          sum(error_count) AS total_errors
        FROM metric_rollups_1m
        WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
        GROUP BY bucket
        ORDER BY bucket
      `,
      query_params: {
        from: fromMinute.toISOString(),
        to: toMinute.toISOString(),
      },
      format: 'JSONEachRow',
    })
    return result.json()
  }

  /** Get the latest published feed value */
  async getLatestFeedValue(feedId: string): Promise<StoredFeedValue | null> {
    const result = await this.client.query({
      query: `
        SELECT *
        FROM published_feed_values
        WHERE feed_id = {feedId:String}
        ORDER BY computed_at DESC
        LIMIT 1
      `,
      query_params: { feedId },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as StoredFeedValue[]
    return rows[0] ?? null
  }

  /** Close the ClickHouse connection */
  async close(): Promise<void> {
    await this.client.close()
  }
}
