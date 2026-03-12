import type pg from 'pg'
import {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
  type RawEconomicEvent,
} from '@lucid/oracle-core'
import type { Checkpoint } from './checkpoint.js'

/** Poll a single gateway table using compound watermark. Returns new rows transformed to events. */
export async function pollGatewayTable(
  pool: pg.Pool,
  checkpoint: Checkpoint,
): Promise<{ events: RawEconomicEvent[]; lastTs: Date | null; lastId: string | null }> {
  const { source_table, watermark_column, last_seen_ts, last_seen_id } = checkpoint

  const result = await pool.query(
    `SELECT * FROM ${source_table}
     WHERE (${watermark_column}, id) > ($1, $2)
     ORDER BY ${watermark_column}, id
     LIMIT 1000`,
    [last_seen_ts, last_seen_id]
  )

  if (result.rows.length === 0) {
    return { events: [], lastTs: null, lastId: null }
  }

  const events = result.rows.map((row: Record<string, unknown>) => {
    switch (source_table) {
      case 'receipt_events':
        return transformReceiptEvent(row as Parameters<typeof transformReceiptEvent>[0])
      case 'mcpgate_audit_log':
        return transformAuditLogEntry(row as Parameters<typeof transformAuditLogEntry>[0])
      case 'gateway_payment_sessions':
        return transformPaymentSession(row as Parameters<typeof transformPaymentSession>[0])
      default:
        throw new Error(`Unknown source table: ${source_table}`)
    }
  })

  const lastRow = result.rows[result.rows.length - 1]
  const lastTs = new Date(lastRow[watermark_column] as string)
  const lastId = lastRow.id as string

  return { events, lastTs, lastId }
}

/** Poll all gateway tables and return combined events with metadata. */
export async function pollAllTables(
  pool: pg.Pool,
  checkpoints: Checkpoint[],
): Promise<{ events: RawEconomicEvent[]; updates: Array<{ table: string; ts: Date; id: string }> }> {
  const allEvents: RawEconomicEvent[] = []
  const updates: Array<{ table: string; ts: Date; id: string }> = []

  for (const cp of checkpoints) {
    const { events, lastTs, lastId } = await pollGatewayTable(pool, cp)
    allEvents.push(...events)
    if (lastTs && lastId) {
      updates.push({ table: cp.source_table, ts: lastTs, id: lastId })
    }
  }

  return { events: allEvents, updates }
}
