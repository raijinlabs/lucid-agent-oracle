import { Pool } from 'pg'
import type { RedisClientType } from 'redis'
import type { Channel, OracleEvent } from '@lucid/oracle-core'
import { evaluateCondition, matchesFilter } from './evaluate.js'
import { buildDeliveryPayload, signPayload, decryptSecret, deliverWebhook } from './deliver.js'
import { scheduleRetry, MAX_ATTEMPTS } from './retry.js'

const STREAM_KEY = 'oracle:webhooks'
const GROUP_NAME = 'webhook-workers'

export { STREAM_KEY, GROUP_NAME }

export interface Subscription {
  id: string
  channel: string
  webhook_url: string
  filter_json: Record<string, string[]> | null
  conditions_json: { field: string; operator: string; threshold: number } | null
  secret_encrypted: string
  max_retries: number
}

// In-memory subscription cache
export type SubCache = Map<string, { subs: Subscription[]; fetchedAt: number }>
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
