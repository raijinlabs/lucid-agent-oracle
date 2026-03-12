import pg from 'pg'

const { Pool } = pg

export interface Checkpoint {
  source_table: string
  watermark_column: string
  last_seen_ts: string
  last_seen_id: string
}

export class CheckpointManager {
  private readonly pool: InstanceType<typeof Pool>

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  async loadAll(): Promise<Checkpoint[]> {
    const result = await this.pool.query(
      'SELECT source_table, watermark_column, last_seen_ts, last_seen_id FROM oracle_worker_checkpoints'
    )
    return result.rows.map((r: Record<string, unknown>) => ({
      source_table: r.source_table as string,
      watermark_column: r.watermark_column as string,
      last_seen_ts: r.last_seen_ts instanceof Date
        ? r.last_seen_ts.toISOString()
        : String(r.last_seen_ts),
      last_seen_id: r.last_seen_id as string,
    }))
  }

  async advance(sourceTable: string, ts: Date, id: string): Promise<void> {
    await this.pool.query(
      'UPDATE oracle_worker_checkpoints SET last_seen_ts = $2, last_seen_id = $3, updated_at = now() WHERE source_table = $1',
      [sourceTable, ts.toISOString(), id]
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
