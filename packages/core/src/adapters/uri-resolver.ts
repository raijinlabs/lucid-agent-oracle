/**
 * URI Resolver — fetches ERC-8004 agent registration JSON files and extracts
 * services, endpoints, and wallets.
 *
 * Runs on a timer (default 5 min). Processes agents with unresolved agent_uri.
 * Respects rate limits (max 10 URIs per cycle, 200ms between requests).
 */
import type pg from 'pg'

export interface URIResolverConfig {
  intervalMs: number
  batchSize: number
  requestDelayMs: number
  timeoutMs: number
}

const DEFAULT_CONFIG: URIResolverConfig = {
  intervalMs: 300_000,     // 5 minutes
  batchSize: 10,           // max URIs per cycle
  requestDelayMs: 200,     // between requests
  timeoutMs: 5000,         // per-request timeout
}

interface RegistrationFile {
  type?: string
  name?: string
  description?: string
  image?: string
  active?: boolean
  x402Support?: boolean
  services?: Array<{ type: string; endpoint: string; version?: string }>
  wallets?: Array<{ chain: string; address: string }>
  registrations?: Array<{ agentRegistry: string; agentId: string }>
  supportedTrust?: string[]
}

export async function resolveAgentURIs(
  pool: pg.Pool,
  config: URIResolverConfig = DEFAULT_CONFIG,
): Promise<number> {
  const client = await pool.connect()
  let resolved = 0

  try {
    // Advisory lock — only one resolver instance at a time
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('uri_resolver'))")
    if (!lockResult.rows[0].pg_try_advisory_lock) {
      return 0
    }

    const result = await client.query(
      `SELECT id, erc8004_id, agent_uri FROM oracle_agent_entities
       WHERE agent_uri IS NOT NULL
         AND agent_uri LIKE 'http%'
         AND (uri_resolved_at IS NULL OR uri_resolved_at < now() - interval '24 hours')
       ORDER BY uri_resolved_at NULLS FIRST
       LIMIT $1`,
      [config.batchSize],
    )

    for (const row of result.rows) {
      try {
        const registration = await fetchRegistrationFile(row.agent_uri as string, config.timeoutMs)

        if (registration) {
          // Store parsed registration data
          const meta: Record<string, unknown> = {}
          if (registration.name) meta.name = registration.name
          if (registration.description) meta.description = registration.description
          if (registration.active !== undefined) meta.active = registration.active
          if (registration.x402Support) meta.x402Support = true
          if (registration.services) meta.services = registration.services
          if (registration.supportedTrust) meta.supportedTrust = registration.supportedTrust

          await client.query(
            `UPDATE oracle_agent_entities
             SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $1::jsonb,
                 display_name = COALESCE($2, display_name),
                 uri_resolved_at = now(),
                 updated_at = now()
             WHERE id = $3`,
            [JSON.stringify(meta), registration.name ?? null, row.id],
          )

          // Extract wallets from registration file
          if (registration.wallets) {
            for (const wallet of registration.wallets) {
              if (wallet.address && wallet.chain) {
                await client.query(
                  `INSERT INTO oracle_wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash)
                   VALUES ($1, $2, $3, 'uri_declared', 0.8, $4)
                   ON CONFLICT (chain, address) WHERE removed_at IS NULL DO NOTHING`,
                  [row.id, wallet.chain.toLowerCase(), wallet.address.toLowerCase(), row.agent_uri],
                )
              }
            }
          }

          // Extract wallet-like service endpoints
          if (registration.services) {
            for (const svc of registration.services) {
              if (svc.type === 'wallet' && svc.endpoint) {
                await client.query(
                  `INSERT INTO oracle_wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash)
                   VALUES ($1, 'base', $2, 'uri_declared', 0.7, $3)
                   ON CONFLICT (chain, address) WHERE removed_at IS NULL DO NOTHING`,
                  [row.id, svc.endpoint.toLowerCase(), row.agent_uri],
                )
              }
            }
          }

          resolved++
        } else {
          // Mark as resolved (empty) to avoid re-fetching
          await client.query(
            `UPDATE oracle_agent_entities
             SET uri_resolved_at = now(),
                 metadata_json = COALESCE(metadata_json, '{}'::jsonb) || '{"uri_error": "empty_or_invalid"}'::jsonb
             WHERE id = $1`,
            [row.id],
          )
        }
      } catch (err) {
        await client.query(
          `UPDATE oracle_agent_entities
           SET uri_resolved_at = now(),
               metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $1::jsonb
           WHERE id = $2`,
          [JSON.stringify({ uri_error: (err as Error).message.slice(0, 200) }), row.id],
        )
      }

      // Rate limiting
      await new Promise((r) => setTimeout(r, config.requestDelayMs))
    }

    await client.query("SELECT pg_advisory_unlock(hashtext('uri_resolver'))")
  } finally {
    client.release()
  }

  return resolved
}

async function fetchRegistrationFile(uri: string, timeoutMs: number): Promise<RegistrationFile | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(uri, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })

    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json') && !contentType.includes('text')) return null

    const text = await res.text()
    if (text.length > 1_000_000) return null // 1MB max

    return JSON.parse(text) as RegistrationFile
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start the URI resolver on a timer.
 */
export function startURIResolver(
  pool: pg.Pool,
  config: URIResolverConfig = DEFAULT_CONFIG,
): { stop: () => void } {
  let running = true

  const loop = async () => {
    while (running) {
      try {
        const n = await resolveAgentURIs(pool, config)
        if (n > 0) console.log(`[uri-resolver] Resolved ${n} agent URIs`)
      } catch (err) {
        console.error('[uri-resolver] Error:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, config.intervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
