import type { RedisClientType } from 'redis'

export const MAX_ATTEMPTS = 5
const RETRY_KEY = 'oracle:webhook_retries'
const STREAM_KEY = 'oracle:webhooks'

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s */
export function getBackoffMs(attempt: number): number {
  return 1000 * Math.pow(2, attempt - 1)
}

/** Schedule a retry by adding to the sorted set delay queue */
export async function scheduleRetry(
  redis: RedisClientType,
  messageData: Record<string, string>,
  attempt: number,
): Promise<void> {
  const delayMs = getBackoffMs(attempt)
  const dueAt = Date.now() + delayMs
  const payload = JSON.stringify({ ...messageData, attempt: String(attempt) })
  await redis.zAdd(RETRY_KEY, { score: dueAt, value: payload })
}

/** Poll the delay queue and move due items back to the main stream */
export async function processDueRetries(
  redis: RedisClientType,
): Promise<number> {
  const now = Date.now()
  // Get items with score <= now (they are due)
  const due = await redis.zRangeByScore(RETRY_KEY, 0, now)
  if (due.length === 0) return 0

  let processed = 0
  for (const item of due) {
    try {
      const data = JSON.parse(item) as Record<string, string>
      // Re-add to stream
      await redis.xAdd(STREAM_KEY, '*', data)
      // Remove from sorted set
      await redis.zRem(RETRY_KEY, item)
      processed++
    } catch {
      // Skip malformed entries
      await redis.zRem(RETRY_KEY, item)
    }
  }
  return processed
}
