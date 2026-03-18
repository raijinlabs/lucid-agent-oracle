import { createClient, type RedisClientType } from 'redis'
import { Pool } from 'pg'
import type { Channel, OracleEvent } from '@lucid/oracle-core'
import { evaluateCondition, matchesFilter } from './evaluate.js'
import { buildDeliveryPayload, signPayload, decryptSecret, deliverWebhook } from './deliver.js'
import { scheduleRetry, processDueRetries, MAX_ATTEMPTS } from './retry.js'

const STREAM_KEY = 'oracle:webhooks'
const GROUP_NAME = 'webhook-workers'
const BLOCK_MS = 5000
const RETRY_POLL_MS = 1000

let shuttingDown = false

interface Subscription {
  id: string
  channel: string
  webhook_url: string
  filter_json: Record<string, string[]> | null
  conditions_json: { field: string; operator: string; threshold: number } | null
  secret_encrypted: string
  max_retries: number
}

// In-memory subscription cache
type SubCache = Map<string, { subs: Subscription[]; fetchedAt: number }>
const CACHE_TTL = 60_000

async function getSubscriptions(
  db: Pool,
  channel: string,
  cache: SubCache,
): Promise<Subscription[]> {
  const cached = cache.get(channel)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.subs

  const result = await db.query(
    `SELECT id, channel, webhook_url, filter_json, conditions_json, secret_encrypted, max_retries
     FROM oracle_subscriptions
     WHERE channel = $1 AND active = true AND type = 'webhook'`,
    [channel],
  )
  const subs = result.rows as Subscription[]
  cache.set(channel, { subs, fetchedAt: Date.now() })
  return subs
}

// Exported for testing
export async function processMessage(
  redis: RedisClientType,
  db: Pool,
  messageId: string,
  fields: Record<string, string>,
  cache: SubCache,
): Promise<void> {
  const channel = fields.channel as Channel
  const eventData: OracleEvent = JSON.parse(fields.payload)
  const payload = (eventData.payload ?? eventData) as Record<string, unknown>
  const attempt = parseInt(fields.attempt ?? '1', 10)

  const subscriptions = await getSubscriptions(db, channel, cache)

  for (const sub of subscriptions) {
    // Apply filter
    if (!matchesFilter(channel, sub.filter_json, payload)) continue

    // Evaluate condition
    if (!evaluateCondition(sub.conditions_json as any, payload)) continue

    // Build and sign
    const deliveryBody = buildDeliveryPayload(eventData.id, channel, payload)
    const bodyStr = JSON.stringify(deliveryBody)
    const secret = decryptSecret(sub.secret_encrypted)
    const signature = signPayload(bodyStr, secret)

    // Deliver
    const result = await deliverWebhook(
      sub.webhook_url,
      bodyStr,
      signature,
      parseInt(process.env.WEBHOOK_TIMEOUT_MS ?? '5000', 10),
    )

    // Write delivery record
    const maxRetries = sub.max_retries ?? MAX_ATTEMPTS
    const state = result.delivered ? 'delivered' : (result.retryable && attempt < maxRetries ? 'pending' : 'failed')

    await db.query(
      `INSERT INTO oracle_webhook_deliveries
        (id, subscription_id, event_id, attempt, status_code, error, state, delivered_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7)`,
      [
        sub.id,
        eventData.id,
        attempt,
        result.statusCode,
        result.error,
        state,
        result.delivered ? new Date().toISOString() : null,
      ],
    )

    // Schedule retry if needed
    if (result.retryable && attempt < maxRetries) {
      await scheduleRetry(redis, {
        channel,
        payload: fields.payload,
        attempt: String(attempt + 1),
        subscription_id: sub.id,
      }, attempt + 1)
    }
  }

  // ACK the original message
  await redis.xAck(STREAM_KEY, GROUP_NAME, messageId)
}

// ── Main entry point ─────────────────────────────────────────

async function main(): Promise<void> {
  const redis = createClient({ url: process.env.REDIS_URL })
  await redis.connect()

  const db = new Pool({ connectionString: process.env.DATABASE_URL })

  const consumerId = process.env.WEBHOOK_CONSUMER_ID ?? `worker-${process.pid}`
  const cache: SubCache = new Map()

  // Ensure consumer group exists
  try {
    await redis.xGroupCreate(STREAM_KEY, GROUP_NAME, '0', { MKSTREAM: true })
  } catch (err: unknown) {
    // BUSYGROUP = group already exists, that's fine
    if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err
  }

  console.log(`[webhook-worker] Consumer ${consumerId} starting...`)

  // Retry polling loop
  const retryInterval = setInterval(async () => {
    try {
      const n = await processDueRetries(redis as any)
      if (n > 0) console.log(`[webhook-worker] Moved ${n} retries back to stream`)
    } catch (err) {
      console.error('[webhook-worker] Retry poll error:', err)
    }
  }, RETRY_POLL_MS)

  // Main consumer loop
  while (!shuttingDown) {
    try {
      // Auto-claim idle messages (crash recovery)
      try {
        const claimed = await redis.xAutoClaim(STREAM_KEY, GROUP_NAME, consumerId, 30_000, '0-0', { COUNT: 10 })
        if (claimed.messages.length > 0) {
          for (const msg of claimed.messages) {
            if (msg) await processMessage(redis as any, db, msg.id, msg.message, cache)
          }
        }
      } catch {
        // XAUTOCLAIM may fail if group doesn't exist yet
      }

      // Read new messages
      const results = await redis.xReadGroup(
        GROUP_NAME,
        consumerId,
        { key: STREAM_KEY, id: '>' },
        { COUNT: 10, BLOCK: BLOCK_MS },
      )

      if (results) {
        for (const stream of results) {
          for (const msg of stream.messages) {
            await processMessage(redis as any, db, msg.id, msg.message, cache)
          }
        }
      }
    } catch (err) {
      console.error('[webhook-worker] Loop error:', err)
      // Brief pause before retrying
      await new Promise((r) => setTimeout(r, 1000))
    }
  }

  // Cleanup
  clearInterval(retryInterval)
  await redis.quit()
  await db.end()
  console.log('[webhook-worker] Shut down cleanly')
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[webhook-worker] SIGTERM received — shutting down...')
  shuttingDown = true
})
process.on('SIGINT', () => {
  console.log('[webhook-worker] SIGINT received — shutting down...')
  shuttingDown = true
})

main().catch((err) => {
  console.error('[webhook-worker] Fatal:', err)
  process.exit(1)
})
