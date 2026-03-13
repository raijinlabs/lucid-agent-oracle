import { createClient } from 'redis'
import type { RedisClientType } from 'redis'
import { createHash } from 'node:crypto'
import { PROTOCOL_REGISTRY } from './agent-query.js'

// Module-level singleton
let _client: RedisClientType | null = null

/** SHA-256 hex digest of a string. */
function sha256hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/** Create and connect a Redis client. Returns null if no URL is provided. */
export async function initRedis(url?: string): Promise<RedisClientType | null> {
  if (!url) return null
  const client = createClient({ url }) as RedisClientType
  client.on('error', (err: unknown) => {
    console.error('[redis]', err)
  })
  await client.connect()
  _client = client
  return client
}

/** Return the current Redis client, or null if not initialised. */
export function getRedis(): RedisClientType | null {
  return _client
}

/** Gracefully quit and null the Redis client. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit().catch(() => {})
    _client = null
  }
}

/** Cache key builders. */
export const keys = {
  apiKey: (raw: string) => `oracle:apikey:${sha256hex(raw)}`,
  agentProfile: (id: string) => `oracle:agent:profile:${id}`,
  agentMetrics: (id: string, plan: string) => `oracle:agent:metrics:${id}:${plan}`,
  leaderboard: (version: number | string, sort: string, cursor: string, plan: string) =>
    `oracle:lb:v${version}:${sort}:${cursor}:${plan}`,
  leaderboardVersion: () => `oracle:lb:version`,
  protocolList: () => `oracle:protocols`,
  protocolDetail: (id: string) => `oracle:protocol:${id}`,
  protocolMetrics: (id: string, plan: string) => `oracle:protocol:metrics:${id}:${plan}`,
}

/**
 * Pipeline-delete agent profile + metrics keys for each given agent ID,
 * then INCR the leaderboard version counter and update globalThis.__lbVersion.
 * No-ops if no Redis client is connected.
 */
export async function invalidateAgentCaches(...agentIds: string[]): Promise<void> {
  if (!_client) return

  const pipeline = _client.multi()

  for (const id of agentIds) {
    pipeline.del(keys.agentProfile(id))
    // Invalidate metrics for all known plan levels
    for (const plan of ['free', 'pro', 'growth', 'internal']) {
      pipeline.del(keys.agentMetrics(id, plan))
    }
  }

  pipeline.incr(keys.leaderboardVersion())

  const results = await pipeline.exec()

  // The last result is the new leaderboard version integer
  const newVersion = results[results.length - 1]
  if (typeof newVersion === 'number') {
    ;(globalThis as Record<string, unknown>).__lbVersion = newVersion
  }
}

/**
 * Pipeline-delete protocol list + detail + metrics keys for every protocol
 * in PROTOCOL_REGISTRY. No-ops if no Redis client is connected.
 */
export async function invalidateProtocolCaches(): Promise<void> {
  if (!_client) return

  const pipeline = _client.multi()

  pipeline.del(keys.protocolList())

  for (const id of Object.keys(PROTOCOL_REGISTRY)) {
    pipeline.del(keys.protocolDetail(id))
    for (const plan of ['free', 'pro', 'growth', 'internal']) {
      pipeline.del(keys.protocolMetrics(id, plan))
    }
  }

  await pipeline.exec()
}

/**
 * Read oracle:lb:version from Redis and store in globalThis.__lbVersion.
 * No-ops if no Redis client is connected.
 */
export async function loadLeaderboardVersion(): Promise<void> {
  if (!_client) return

  const raw = await _client.get(keys.leaderboardVersion())
  const version = raw !== null ? parseInt(raw, 10) : 0
  ;(globalThis as Record<string, unknown>).__lbVersion = isNaN(version) ? 0 : version
}
