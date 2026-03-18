/**
 * Resolver polling loop for no-broker adapter mode.
 *
 * Polls oracle_raw_adapter_events staging table for unprocessed events,
 * dispatches to the identity resolver, and marks as processed.
 *
 * The resolver is the SINGLE WRITER to identity tables:
 * - oracle_agent_entities
 * - oracle_wallet_mappings
 * - oracle_identity_links
 * - oracle_identity_evidence
 */
import type pg from 'pg'

const MAX_ERROR_COUNT = 5

export interface ResolverPollConfig {
  pollIntervalMs: number
  batchSize: number
}

export type IdentityDispatcher = (
  source: string,
  payload: Record<string, unknown>,
  db: pg.PoolClient,
) => Promise<void>

/**
 * Process a batch of unprocessed adapter events.
 * Returns the number of successfully processed events.
 */
export async function processAdapterEvents(
  pool: pg.Pool,
  dispatch: IdentityDispatcher,
  batchSize = 100,
): Promise<number> {
  const client = await pool.connect()
  let processed = 0

  try {
    await client.query('BEGIN')

    const result = await client.query(
      `SELECT * FROM oracle_raw_adapter_events
       WHERE processed_at IS NULL AND failed_at IS NULL
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [batchSize],
    )

    for (const row of result.rows) {
      try {
        // Merge row metadata with payload so handlers get the full event shape
        const fullEvent = {
          ...(typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json),
          event_type: row.event_type,
          event_id: row.event_id,
          source: row.source,
          chain: row.chain,
          block_number: row.block_number,
          tx_hash: row.tx_hash,
          log_index: row.log_index,
          timestamp: row.event_timestamp,
        }
        await dispatch(row.source, fullEvent, client)

        await client.query(
          'UPDATE oracle_raw_adapter_events SET processed_at = now() WHERE id = $1',
          [row.id],
        )
        processed++
      } catch (err) {
        const newCount = (row.error_count ?? 0) + 1
        if (newCount >= MAX_ERROR_COUNT) {
          await client.query(
            `UPDATE oracle_raw_adapter_events
             SET error_count = $1, last_error = $2, failed_at = now()
             WHERE id = $3`,
            [newCount, (err as Error).message, row.id],
          )
        } else {
          await client.query(
            `UPDATE oracle_raw_adapter_events
             SET error_count = $1, last_error = $2
             WHERE id = $3`,
            [newCount, (err as Error).message, row.id],
          )
        }
      }
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }

  return processed
}

/**
 * Start a non-overlapping polling loop for adapter event processing.
 * Same pattern as the feed worker — setTimeout after completion, not setInterval.
 */
export function startResolverPoller(
  pool: pg.Pool,
  dispatch: IdentityDispatcher,
  config: ResolverPollConfig = { pollIntervalMs: 5000, batchSize: 100 },
): { stop: () => void } {
  let running = true

  const loop = async () => {
    while (running) {
      try {
        const n = await processAdapterEvents(pool, dispatch, config.batchSize)
        if (n > 0) {
          console.log(`[resolver-poller] Processed ${n} adapter events`)
        }
      } catch (err) {
        console.error('[resolver-poller] Error:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, config.pollIntervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
