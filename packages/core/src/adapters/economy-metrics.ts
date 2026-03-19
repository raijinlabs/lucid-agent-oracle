/**
 * Economy Metrics Computer — generates hourly snapshots of agent economy health.
 *
 * Computes aggregates from oracle tables and stores in oracle_economy_snapshots.
 * Advisory-locked to prevent concurrent execution across replicas.
 * Runs every hour.
 */
import type pg from 'pg'

export interface EconomyMetricsConfig {
  intervalMs: number
}

const DEFAULT_CONFIG: EconomyMetricsConfig = {
  intervalMs: 60 * 60_000, // 1 hour
}

export interface EconomySnapshot {
  snapshot_at: string
  total_agents: number
  active_agents_24h: number
  total_wallets: number
  total_tvl_usd: number
  tx_volume_24h_usd: number
  tx_count_24h: number
  new_agents_7d: number
  avg_reputation_score: number | null
  top_tokens_json: unknown
}

/**
 * Compute and store a single economy snapshot.
 */
export async function computeEconomySnapshot(pool: pg.Pool): Promise<EconomySnapshot | null> {
  const client = await pool.connect()

  try {
    const lockResult = await client.query("SELECT pg_try_advisory_lock(hashtext('economy_metrics'))")
    if (!lockResult.rows[0].pg_try_advisory_lock) return null

    // Run all aggregation queries in parallel
    const [
      totalAgentsResult,
      activeAgents24hResult,
      totalWalletsResult,
      totalTvlResult,
      txVolume24hResult,
      txCount24hResult,
      newAgents7dResult,
      avgReputationResult,
      topTokensResult,
    ] = await Promise.all([
      // total_agents
      client.query('SELECT COUNT(*)::int AS cnt FROM oracle_agent_entities'),

      // active_agents_24h: agents with wallet_transactions in last 24h
      client.query(
        `SELECT COUNT(DISTINCT agent_entity)::int AS cnt
         FROM oracle_wallet_transactions
         WHERE event_timestamp > now() - interval '24 hours'`,
      ),

      // total_wallets: active wallet_mappings count
      client.query(
        'SELECT COUNT(*)::int AS cnt FROM oracle_wallet_mappings WHERE removed_at IS NULL',
      ),

      // total_tvl_usd: SUM of oracle_wallet_balances.balance_usd
      client.query(
        'SELECT COALESCE(SUM(balance_usd), 0)::numeric AS total FROM oracle_wallet_balances',
      ),

      // tx_volume_24h_usd: SUM amount_usd from wallet_transactions last 24h
      client.query(
        `SELECT COALESCE(SUM(amount_usd), 0)::numeric AS total
         FROM oracle_wallet_transactions
         WHERE event_timestamp > now() - interval '24 hours'`,
      ),

      // tx_count_24h: COUNT transactions last 24h
      client.query(
        `SELECT COUNT(*)::int AS cnt
         FROM oracle_wallet_transactions
         WHERE event_timestamp > now() - interval '24 hours'`,
      ),

      // new_agents_7d: agents with created_at in last 7 days
      client.query(
        `SELECT COUNT(*)::int AS cnt
         FROM oracle_agent_entities
         WHERE created_at > now() - interval '7 days'`,
      ),

      // avg_reputation_score: AVG reputation_json->>'avg_value' where <= 100
      client.query(
        `SELECT AVG((reputation_json->>'avg_value')::numeric)::numeric AS avg_score
         FROM oracle_agent_entities
         WHERE reputation_json IS NOT NULL
           AND (reputation_json->>'avg_value')::numeric <= 100`,
      ),

      // top_tokens_json: top 10 tokens by total balance_usd
      client.query(
        `SELECT json_agg(t) AS tokens FROM (
           SELECT token_symbol, chain,
                  SUM(balance_usd)::numeric AS total_usd,
                  COUNT(DISTINCT agent_entity)::int AS holder_count
           FROM oracle_wallet_balances
           WHERE balance_usd > 0 AND token_symbol IS NOT NULL
           GROUP BY token_symbol, chain
           ORDER BY total_usd DESC
           LIMIT 10
         ) t`,
      ),
    ])

    const snapshot: EconomySnapshot = {
      snapshot_at: new Date().toISOString(),
      total_agents: (totalAgentsResult.rows[0]?.cnt as number) ?? 0,
      active_agents_24h: (activeAgents24hResult.rows[0]?.cnt as number) ?? 0,
      total_wallets: (totalWalletsResult.rows[0]?.cnt as number) ?? 0,
      total_tvl_usd: Number(totalTvlResult.rows[0]?.total ?? 0),
      tx_volume_24h_usd: Number(txVolume24hResult.rows[0]?.total ?? 0),
      tx_count_24h: (txCount24hResult.rows[0]?.cnt as number) ?? 0,
      new_agents_7d: (newAgents7dResult.rows[0]?.cnt as number) ?? 0,
      avg_reputation_score: avgReputationResult.rows[0]?.avg_score != null
        ? Number(avgReputationResult.rows[0].avg_score)
        : null,
      top_tokens_json: topTokensResult.rows[0]?.tokens ?? [],
    }

    // Insert snapshot
    const topTokensStr = JSON.stringify(snapshot.top_tokens_json)
    await client.query(
      `INSERT INTO oracle_economy_snapshots
       (snapshot_at, total_agents, active_agents_24h, total_wallets, total_tvl_usd,
        tx_volume_24h_usd, tx_count_24h, new_agents_7d, avg_reputation_score, top_tokens_json)
       VALUES (now(), $1::int, $2::int, $3::int, $4::numeric,
               $5::numeric, $6::int, $7::int, $8::numeric, $9::jsonb)`,
      [
        snapshot.total_agents,
        snapshot.active_agents_24h,
        snapshot.total_wallets,
        snapshot.total_tvl_usd,
        snapshot.tx_volume_24h_usd,
        snapshot.tx_count_24h,
        snapshot.new_agents_7d,
        snapshot.avg_reputation_score,
        topTokensStr,
      ],
    )

    await client.query("SELECT pg_advisory_unlock(hashtext('economy_metrics'))")
    return snapshot
  } finally {
    client.release()
  }
}

/**
 * Start the economy metrics computer on a timer.
 */
export function startEconomyMetrics(
  pool: pg.Pool,
  config?: Partial<EconomyMetricsConfig>,
): { stop: () => void } {
  const fullConfig = { ...DEFAULT_CONFIG, ...config }
  let running = true

  const loop = async () => {
    while (running) {
      try {
        const snapshot = await computeEconomySnapshot(pool)
        if (snapshot) {
          console.log(`[economy-metrics] Snapshot: agents=${snapshot.total_agents} tvl=$${snapshot.total_tvl_usd} txs_24h=${snapshot.tx_count_24h}`)
        }
      } catch (err) {
        console.error('[economy-metrics] Error:', (err as Error).message)
      }
      await new Promise((r) => setTimeout(r, fullConfig.intervalMs))
    }
  }

  loop()
  return { stop: () => { running = false } }
}
