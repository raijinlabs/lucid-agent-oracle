/**
 * Subgraph Ingester — bulk-ingests ERC-8004 agents from The Graph subgraphs.
 *
 * Replaces Ponder for bulk identity data. Queries all agents in batches of 1000
 * across 5 EVM chains (Ethereum, Base, Polygon, BSC, Monad) via deployed subgraphs.
 *
 * On startup: paginate all agents (skip-based) and write staging events.
 * After initial sync: poll every 5 minutes for new agents.
 *
 * Uses the same staging pipeline as Ponder/DirectSink: writes to
 * oracle_raw_adapter_events with source='erc8004', then the resolver-poller
 * picks them up and creates oracle_agent_entities + wallet mappings.
 */
import type pg from 'pg'
import { computeEventId } from '../types/events.js'
import { withAdvisoryLock, startEnricherLoop } from './enricher-utils.js'
import { CHAINS } from './chains.js'

// ── Types ──

export interface SubgraphAgent {
  agentId: string
  owner: string
  agentURI: string
}

export interface SubgraphSyncResult {
  agentsProcessed: number
  lastAgentId: number
}

export interface SubgraphIngesterConfig {
  /** Poll interval after initial sync (default: 5 minutes) */
  pollIntervalMs: number
  /** GraphQL batch size (default: 1000, max for The Graph) */
  batchSize: number
  /** HTTP timeout per query (default: 15 seconds) */
  timeoutMs: number
}

const DEFAULT_CONFIG: SubgraphIngesterConfig = {
  pollIntervalMs: 5 * 60_000,
  batchSize: 1000,
  timeoutMs: 15_000,
}

// ── GraphQL query ──

function buildAgentsQuery(first: number, skip: number): string {
  return JSON.stringify({
    query: `{
  agents(first: ${first}, skip: ${skip}, orderBy: agentId, orderDirection: asc) {
    agentId
    owner
    agentURI
  }
}`,
  })
}

function buildAgentsAfterQuery(first: number, lastAgentId: number): string {
  return JSON.stringify({
    query: `{
  agents(first: ${first}, orderBy: agentId, orderDirection: asc, where: { agentId_gt: "${lastAgentId}" }) {
    agentId
    owner
    agentURI
  }
}`,
  })
}

// ── Subgraph HTTP client ──

export async function querySubgraph(
  url: string,
  body: string,
  timeoutMs: number,
): Promise<SubgraphAgent[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Subgraph HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const json = await res.json() as { data?: { agents?: SubgraphAgent[] }; errors?: { message: string }[] }
    if (json.errors?.length) {
      throw new Error(`Subgraph GraphQL error: ${json.errors[0].message}`)
    }
    return json.data?.agents ?? []
  } finally {
    clearTimeout(timer)
  }
}

// ── Checkpoint helpers ──

const CHECKPOINT_PREFIX = 'subgraph_last_agent_id'

function checkpointKey(chainName: string): string {
  return `${CHECKPOINT_PREFIX}:${chainName}`
}

export async function getCheckpoint(client: pg.PoolClient, chainName: string): Promise<number> {
  const result = await client.query(
    `SELECT last_seen_id FROM oracle_worker_checkpoints WHERE source_table = $1::text`,
    [checkpointKey(chainName)],
  )
  if (result.rows.length === 0) return 0
  return parseInt(String(result.rows[0].last_seen_id), 10) || 0
}

export async function setCheckpoint(client: pg.PoolClient, chainName: string, lastAgentId: number): Promise<void> {
  await client.query(
    `INSERT INTO oracle_worker_checkpoints (source_table, watermark_column, last_seen_ts, last_seen_id, updated_at)
     VALUES ($1::text, 'agent_id', now(), $2::text, now())
     ON CONFLICT (source_table) DO UPDATE SET last_seen_id = EXCLUDED.last_seen_id, last_seen_ts = now(), updated_at = now()`,
    [checkpointKey(chainName), String(lastAgentId)],
  )
}

// ── Core sync function ──

/**
 * Sync a single chain's subgraph, writing new agents as staging events.
 *
 * For initial sync (lastAgentId=0): paginate all agents using skip-based pagination.
 * For incremental sync: fetch agents with agentId > lastAgentId.
 *
 * Returns the number of agents processed and the highest agentId seen.
 */
export async function syncSubgraphChain(
  client: pg.PoolClient,
  chainKey: string,
  chainName: string,
  subgraphUrl: string,
  lastAgentId: number,
  config: SubgraphIngesterConfig = DEFAULT_CONFIG,
): Promise<SubgraphSyncResult> {
  let agentsProcessed = 0
  let highestId = lastAgentId

  if (lastAgentId === 0) {
    // Initial sync — use skip-based pagination to get all agents
    let skip = 0
    while (true) {
      const agents = await querySubgraph(
        subgraphUrl,
        buildAgentsQuery(config.batchSize, skip),
        config.timeoutMs,
      )
      if (agents.length === 0) break

      for (const agent of agents) {
        const written = await writeAgentStagingEvent(client, chainName, agent)
        if (written) agentsProcessed++
        const numId = parseInt(agent.agentId, 10)
        if (!isNaN(numId) && numId > highestId) highestId = numId
      }

      skip += agents.length
      if (agents.length < config.batchSize) break // last page
    }
  } else {
    // Incremental sync — fetch only new agents
    const agents = await querySubgraph(
      subgraphUrl,
      buildAgentsAfterQuery(config.batchSize, lastAgentId),
      config.timeoutMs,
    )

    for (const agent of agents) {
      const written = await writeAgentStagingEvent(client, chainName, agent)
      if (written) agentsProcessed++
      const numId = parseInt(agent.agentId, 10)
      if (!isNaN(numId) && numId > highestId) highestId = numId
    }
  }

  // Update checkpoint
  if (highestId > lastAgentId) {
    await setCheckpoint(client, chainName, highestId)
  }

  return { agentsProcessed, lastAgentId: highestId }
}

// ── Staging event writer ──

/**
 * Write a single agent as a staging event to oracle_raw_adapter_events.
 * Uses deterministic event_id for idempotency (ON CONFLICT DO NOTHING).
 * Returns true if a new row was inserted, false if it already existed.
 */
export async function writeAgentStagingEvent(
  client: pg.PoolClient,
  chainName: string,
  agent: SubgraphAgent,
): Promise<boolean> {
  const eventId = computeEventId('erc8004', chainName, 'subgraph-sync', null, agent.agentId)

  const payload = {
    agent_id: agent.agentId,
    owner_address: agent.owner,
    agent_uri: agent.agentURI,
  }

  const result = await client.query(
    `INSERT INTO oracle_raw_adapter_events
      (event_id, source, source_adapter_ver, chain, event_type,
       event_timestamp, payload_json)
     VALUES ($1::text, $2::text, $3::int, $4::text, $5::text, $6::timestamptz, $7::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      eventId,
      'erc8004',
      2,
      chainName,
      'agent_registered',
      new Date().toISOString(),
      JSON.stringify(payload),
    ],
  )

  return result.rows.length > 0
}

// ── Orchestrator ──

/**
 * Run one full sync cycle across all chains that have subgraph URLs.
 * Chains are processed sequentially; if one fails, others still run.
 */
export async function runSubgraphSync(
  pool: pg.Pool,
  config: SubgraphIngesterConfig = DEFAULT_CONFIG,
): Promise<number> {
  const chainsWithSubgraphs = Object.entries(CHAINS).filter(
    ([, c]) => c.type === 'evm' && c.subgraphUrl,
  )
  console.log(`[subgraph-ingester] Found ${chainsWithSubgraphs.length} chains with subgraphs: ${chainsWithSubgraphs.map(([id]) => id).join(', ')}`)
  if (chainsWithSubgraphs.length === 0) return 0

  const result = await withAdvisoryLock(pool, 'subgraph_ingester', async (client) => {
    let totalProcessed = 0

    for (const [chainId, chainConfig] of chainsWithSubgraphs) {
      try {
        console.log(`[subgraph-ingester] Syncing ${chainConfig.name}...`)
        const lastAgentId = await getCheckpoint(client, chainId)
        console.log(`[subgraph-ingester] ${chainConfig.name} checkpoint: ${lastAgentId}`)
        const syncResult = await syncSubgraphChain(
          client,
          chainId,      // e.g., 'base'
          chainId,      // chainName same as chainId
          chainConfig.subgraphUrl!,
          lastAgentId,
          config,
        )
        totalProcessed += syncResult.agentsProcessed
        if (syncResult.agentsProcessed > 0) {
          console.log(
            `[subgraph-ingester] ${chainConfig.name}: +${syncResult.agentsProcessed} agents (last ID: ${syncResult.lastAgentId})`,
          )
        }
      } catch (err) {
        console.error(
          `[subgraph-ingester] ${chainConfig.name} error:`,
          (err as Error).message,
        )
        // Continue with other chains
      }
    }

    return totalProcessed
  })

  return result ?? 0
}

// ── Entrypoint ──

/**
 * Start the subgraph ingester loop.
 * Runs initial sync immediately, then polls every `pollIntervalMs`.
 */
export function startSubgraphIngester(
  pool: pg.Pool,
  config: Partial<SubgraphIngesterConfig> = {},
): { stop: () => void } {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  return startEnricherLoop(
    'subgraph-ingester',
    fullConfig.pollIntervalMs,
    async () => {
      console.log('[subgraph-ingester] Starting sync cycle...')
      const n = await runSubgraphSync(pool, fullConfig)
      console.log(`[subgraph-ingester] Cycle complete: ${n} agents`)
      return n > 0 ? n : null
    },
  )
}
