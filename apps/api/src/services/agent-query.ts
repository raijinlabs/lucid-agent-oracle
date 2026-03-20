import type { DbClient } from '@lucid/oracle-core'

// ---------------------------------------------------------------------------
// Protocol Registry
// ---------------------------------------------------------------------------

export const PROTOCOL_REGISTRY: Record<string, { name: string; chains: string[]; status: string }> = {
  lucid: { name: 'Lucid', chains: ['offchain', 'base', 'solana'], status: 'active' },
  virtuals: { name: 'Virtuals Protocol', chains: ['base'], status: 'pending' },
  olas: { name: 'Olas / Autonolas', chains: ['gnosis', 'base', 'optimism'], status: 'pending' },
  erc8004: { name: 'ERC-8004 Agent Registry', chains: ['base'], status: 'active' },
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AgentProfile {
  id: string
  display_name: string | null
  erc8004_id: string | null
  lucid_tenant: string | null
  image_url: string | null
  description: string | null
  category: string | null
  ecosystem: string | null
  active: boolean | null
  reputation_json: Record<string, unknown> | null
  reputation_updated_at: string | null
  created_at: string
  updated_at: string
  wallets: Array<{ chain: string; address: string; link_type: string; confidence: number }>
  identity_links: Array<{ protocol: string; protocol_id: string; link_type: string; confidence: number }>
  feedback_count: number
}

export interface BalanceSummary {
  total_usd: number
  tokens: Array<{
    chain: string
    token_address: string
    token_symbol: string | null
    balance_raw: string
    balance_usd: number
  }>
}

export interface TransactionsSummary {
  count_24h: number
  count_7d: number
  volume_usd_24h: number
  volume_usd_7d: number
}

export interface FeedbackEntry {
  id: number
  client_address: string
  value: number
  tag1: string | null
  tag2: string | null
  endpoint: string | null
  event_timestamp: string | null
  created_at: string
}

export interface EnrichedAgentProfile extends AgentProfile {
  balances: BalanceSummary
  transactions_summary: TransactionsSummary
  feedback: FeedbackEntry[]
}

export interface AgentSearchResult {
  id: string
  display_name: string | null
  erc8004_id: string | null
  created_at: string
}

export interface SearchParams {
  wallet?: string
  chain?: string
  protocol?: string
  protocol_id?: string
  erc8004_id?: string
  q?: string
  sort?: 'newest' | 'wallets' | 'protocols' | 'evidence' | 'reputation_score' | 'smart' | 'tx_count' | 'tvl'
  limit: number
  offset: number
  cursorValue?: string
  cursorId?: string
}

export interface LeaderboardEntry {
  id: string
  display_name: string | null
  erc8004_id: string | null
  wallet_count: number
  protocol_count: number
  evidence_count: number
  created_at: string
}

export interface LeaderboardParams {
  sort: 'wallet_count' | 'protocol_count' | 'evidence_count' | 'newest' | 'tx_count' | 'tvl'
  limit: number
  offset: number
  cursorValue?: number | string
  cursorId?: string
}

export interface CursorResult<T> {
  data: T[]
  has_more: boolean
  last_sort_value?: string | number
  last_id?: string
}

export interface AgentMetrics {
  id: string
  wallets: {
    total: number
    by_chain: Record<string, number>
    by_link_type: Record<string, number>
  }
  evidence: {
    total: number
    by_type: Record<string, number>
  }
  protocols: {
    total: number
    list: string[]
  }
  conflicts: {
    active: number
    resolved: number
  }
  first_seen: string
  last_active: string
}

export interface ActivityEvent {
  type: 'evidence_added' | 'conflict_opened' | 'wallet_linked'
  timestamp: string
  detail: Record<string, unknown>
}

export interface ProtocolDetail {
  id: string
  name: string
  chains: string[]
  status: string
  agent_count: number
  wallet_count: number
}

export interface AgentGraphEdge {
  from_agent: string
  to_agent: string
  tx_count: number
  total_usd: number
}

export interface ProtocolMetrics {
  id: string
  name: string
  chains: string[]
  status: string
  agents: {
    total: number
    by_link_type: Record<string, number>
  }
  wallets: {
    total: number
    by_chain: Record<string, number>
  }
  evidence: {
    total: number
    by_type: Record<string, number>
  }
  recent_registrations_7d: number
  active_conflicts: number
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AgentQueryService {
  constructor(private readonly db: DbClient) {}

  // ---- exists -------------------------------------------------------------

  async exists(id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      'SELECT 1 FROM oracle_agent_entities WHERE id = $1',
      [id],
    )
    return rows.length > 0
  }

  // ---- getProfile --------------------------------------------------------

  async getProfile(id: string): Promise<AgentProfile | null> {
    const { rows: entityRows } = await this.db.query(
      'SELECT * FROM oracle_agent_entities WHERE id = $1',
      [id],
    )
    if (entityRows.length === 0) return null

    const entity = entityRows[0]

    const [walletResult, linkResult, evidenceResult] = await Promise.all([
      this.db.query(
        `SELECT chain, address, link_type, confidence
         FROM oracle_wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL
         ORDER BY created_at`,
        [id],
      ),
      this.db.query(
        `SELECT protocol, protocol_id, link_type, confidence
         FROM oracle_identity_links
         WHERE agent_entity = $1
         ORDER BY created_at`,
        [id],
      ),
      this.db.query(
        `SELECT COUNT(*)::int AS cnt
         FROM oracle_agent_feedback
         WHERE agent_entity = $1`,
        [id],
      ),
    ])

    const meta = entity.metadata_json as Record<string, unknown> | null
    const repJson = entity.reputation_json as Record<string, unknown> | null

    return {
      id: entity.id as string,
      display_name: (entity.display_name as string) ?? null,
      erc8004_id: (entity.erc8004_id as string) ?? null,
      lucid_tenant: (entity.lucid_tenant as string) ?? null,
      image_url: (entity.image_url as string) ?? null,
      description: (entity.description as string) ?? meta?.description as string ?? null,
      category: (entity.category as string) ?? null,
      ecosystem: (meta?.ecosystem as string) ?? null,
      active: meta?.active as boolean ?? null,
      agent_uri: (entity.agent_uri as string) ?? null,
      metadata_json: meta ?? null,
      reputation_json: repJson ?? null,
      reputation_updated_at: entity.reputation_updated_at
        ? String(entity.reputation_updated_at)
        : null,
      created_at: String(entity.created_at),
      updated_at: String(entity.updated_at),
      wallets: walletResult.rows.map((r) => ({
        chain: r.chain as string,
        address: r.address as string,
        link_type: r.link_type as string,
        confidence: r.confidence as number,
      })),
      identity_links: linkResult.rows.map((r) => ({
        protocol: r.protocol as string,
        protocol_id: r.protocol_id as string,
        link_type: r.link_type as string,
        confidence: r.confidence as number,
      })),
      feedback_count: (evidenceResult.rows[0]?.cnt as number) ?? 0,
    }
  }

  // ---- getEnrichedProfile ------------------------------------------------

  async getEnrichedProfile(id: string): Promise<EnrichedAgentProfile | null> {
    const profile = await this.getProfile(id)
    if (!profile) return null

    // Fetch enrichment data in parallel
    const [balancesResult, txSummaryResult, feedbackResult] = await Promise.all([
      // Token balances for this agent
      this.db.query(
        `SELECT chain, token_address, token_symbol, balance_raw, balance_usd
         FROM oracle_wallet_balances
         WHERE agent_entity = $1
         ORDER BY balance_usd DESC`,
        [id],
      ),
      // Transaction summary
      this.db.query(
        `SELECT
           COUNT(*) FILTER (WHERE event_timestamp > now() - interval '24 hours')::int AS count_24h,
           COUNT(*) FILTER (WHERE event_timestamp > now() - interval '7 days')::int AS count_7d,
           COALESCE(SUM(amount_usd) FILTER (WHERE event_timestamp > now() - interval '24 hours'), 0)::numeric AS volume_usd_24h,
           COALESCE(SUM(amount_usd) FILTER (WHERE event_timestamp > now() - interval '7 days'), 0)::numeric AS volume_usd_7d
         FROM oracle_wallet_transactions
         WHERE agent_entity = $1`,
        [id],
      ),
      // Recent feedback (last 10)
      this.db.query(
        `SELECT id, client_address, value, tag1, tag2, endpoint, event_timestamp, created_at
         FROM oracle_agent_feedback
         WHERE agent_entity = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [id],
      ),
    ])

    const tokens = balancesResult.rows.map((r) => ({
      chain: r.chain as string,
      token_address: r.token_address as string,
      token_symbol: (r.token_symbol as string) ?? null,
      balance_raw: (r.balance_raw as string) ?? '0',
      balance_usd: Number(r.balance_usd ?? 0),
    }))

    const totalUsd = tokens.reduce((sum, t) => sum + t.balance_usd, 0)

    const txRow = txSummaryResult.rows[0] ?? {}
    const transactionsSummary: TransactionsSummary = {
      count_24h: Number(txRow.count_24h ?? 0),
      count_7d: Number(txRow.count_7d ?? 0),
      volume_usd_24h: Number(txRow.volume_usd_24h ?? 0),
      volume_usd_7d: Number(txRow.volume_usd_7d ?? 0),
    }

    const feedback: FeedbackEntry[] = feedbackResult.rows.map((r) => ({
      id: Number(r.id),
      client_address: r.client_address as string,
      value: Number(r.value),
      tag1: (r.tag1 as string) ?? null,
      tag2: (r.tag2 as string) ?? null,
      endpoint: (r.endpoint as string) ?? null,
      event_timestamp: r.event_timestamp ? String(r.event_timestamp) : null,
      created_at: String(r.created_at),
    }))

    return {
      ...profile,
      balances: {
        total_usd: totalUsd,
        tokens,
      },
      transactions_summary: transactionsSummary,
      feedback,
    }
  }

  private getSortClause(sort?: string): string {
    // Use column aliases from SELECT list (required by DISTINCT)
    switch (sort) {
      case 'wallets': return 'wallet_count DESC'
      case 'protocols': return 'protocol_count DESC'
      case 'evidence': return 'feedback_count DESC'
      case 'reputation_score': return 'reputation_score DESC NULLS LAST'
      // Smart ranking: composite score weighting reputation, activity, and completeness
      // Industry standard: weighted multi-factor ranking (similar to GitHub stars + forks + issues)
      case 'smart': return 'smart_score DESC NULLS LAST'
      case 'tx_count': return 'tx_count DESC NULLS LAST'
      case 'tvl': return 'tvl DESC NULLS LAST'
      default: return 'ae.created_at DESC'
    }
  }

  // ---- search ------------------------------------------------------------

  async search(params: SearchParams): Promise<CursorResult<AgentSearchResult>> {
    const limit = Math.min(Math.max(params.limit, 1), 100)

    const conditions: string[] = []
    const values: unknown[] = []
    const joins: string[] = []
    let paramIdx = 0

    const nextParam = (): string => {
      paramIdx++
      return `$${paramIdx}`
    }

    if (params.wallet) {
      joins.push(
        'JOIN oracle_wallet_mappings wm ON wm.agent_entity = ae.id AND wm.removed_at IS NULL',
      )
      conditions.push(`LOWER(wm.address) = LOWER(${nextParam()})`)
      values.push(params.wallet)

      if (params.chain) {
        conditions.push(`wm.chain = ${nextParam()}`)
        values.push(params.chain)
      }
    }

    if (params.protocol) {
      joins.push(
        'JOIN oracle_identity_links il ON il.agent_entity = ae.id',
      )
      conditions.push(`il.protocol = ${nextParam()}`)
      values.push(params.protocol)

      if (params.protocol_id) {
        conditions.push(`il.protocol_id = ${nextParam()}`)
        values.push(params.protocol_id)
      }
    }

    if (params.erc8004_id) {
      conditions.push(`ae.erc8004_id = ${nextParam()}`)
      values.push(params.erc8004_id)
    }

    if (params.q && params.q !== '*') {
      const qParam = nextParam()
      conditions.push(`(ae.display_name ILIKE ${qParam} OR ae.erc8004_id = ${nextParam()})`)
      values.push(`%${params.q}%`)
      values.push(params.q) // exact match on erc8004_id
    }
    // q=* is a wildcard — list all agents (no filter added)

    // Keyset cursor condition (only works with default created_at sort)
    if (params.cursorValue && params.cursorId && (!params.sort || params.sort === 'newest')) {
      const cvParam = nextParam()
      const ciParam = nextParam()
      conditions.push(`(ae.created_at, ae.id) < (${cvParam}, ${ciParam})`)
      values.push(params.cursorValue)
      values.push(params.cursorId)
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : ''
    const joinClause = joins.join(' ')

    // Data query — fetch limit+1 for has_more detection
    const limitParam = nextParam()
    values.push(limit + 1)

    // For non-default sort, use OFFSET pagination (cursor value = offset number)
    const useOffset = params.sort && params.sort !== 'newest' && params.cursorValue
    const offsetClause = useOffset ? `OFFSET ${nextParam()}` : ''
    if (useOffset) values.push(parseInt(String(params.cursorValue), 10) || 0)

    const dataSql = `SELECT DISTINCT ae.id, ae.display_name, ae.erc8004_id, ae.created_at,
        ae.agent_uri, ae.metadata_json, ae.reputation_json,
        (SELECT count(*) FROM oracle_wallet_mappings wm2 WHERE wm2.agent_entity = ae.id AND wm2.removed_at IS NULL) as wallet_count,
        (SELECT count(*) FROM oracle_identity_links il2 WHERE il2.agent_entity = ae.id) as protocol_count,
        (SELECT count(*) FROM oracle_agent_feedback fb WHERE fb.agent_entity = ae.id) as feedback_count,
        CASE WHEN ae.reputation_json IS NOT NULL AND (ae.reputation_json->>'avg_value')::numeric <= 100
             THEN (ae.reputation_json->>'avg_value')::numeric ELSE NULL END as reputation_score,
        (
          COALESCE(CASE WHEN ae.reputation_json IS NOT NULL AND (ae.reputation_json->>'avg_value')::numeric <= 100
            THEN (ae.reputation_json->>'avg_value')::numeric ELSE 0 END, 0) * 0.3
          + LEAST((SELECT count(*) FROM oracle_agent_feedback fb2 WHERE fb2.agent_entity = ae.id), 100) * 0.3
          + LEAST((SELECT count(*) FROM oracle_wallet_mappings wm4 WHERE wm4.agent_entity = ae.id AND wm4.removed_at IS NULL), 5) * 20 * 0.2
          + CASE WHEN ae.display_name IS NOT NULL THEN 50 ELSE 0 END * 0.1
          + CASE WHEN ae.metadata_json->>'active' = 'true' THEN 50 ELSE 0 END * 0.1
        ) as smart_score,
        (SELECT count(*) FROM oracle_wallet_transactions wt WHERE wt.agent_entity = ae.id) as tx_count,
        (SELECT COALESCE(SUM(wb.balance_usd), 0) FROM oracle_wallet_balances wb WHERE wb.agent_entity = ae.id) as tvl
      FROM oracle_agent_entities ae ${joinClause} ${whereClause}
      ORDER BY ${this.getSortClause(params.sort)}, ae.id DESC
      LIMIT ${limitParam} ${offsetClause}`

    const { rows } = await this.db.query(dataSql, values)

    const hasMore = rows.length > limit
    const trimmed = hasMore ? rows.slice(0, limit) : rows

    const data = trimmed.map((r) => {
      const meta = r.metadata_json as Record<string, any> | null
      const rep = r.reputation_json as Record<string, any> | null
      const services = Array.isArray(meta?.services) ? meta.services : []
      return {
        id: r.id as string,
        display_name: (r.display_name as string) ?? null,
        erc8004_id: (r.erc8004_id as string) ?? null,
        created_at: String(r.created_at),
        wallet_count: Number(r.wallet_count ?? 0),
        protocol_count: Number(r.protocol_count ?? 0),
        feedback_count: Number(r.feedback_count ?? 0),
        agent_uri: (r.agent_uri as string) ?? null,
        description: (meta?.description as string) ?? null,
        ecosystem: (meta?.ecosystem as string) ?? null,
        active: meta?.active ?? null,
        services_count: services.length,
        reputation_score: rep?.avg_value ? Number(rep.avg_value) : null,
        tx_count: Number(r.tx_count ?? 0),
        tvl: Number(r.tvl ?? 0),
      }
    })

    const last = data[data.length - 1]
    // For non-default sort, cursor is offset-based (next page offset number)
    const currentOffset = useOffset ? (parseInt(String(params.cursorValue), 10) || 0) : 0
    return {
      data,
      has_more: hasMore,
      ...(last && (!params.sort || params.sort === 'newest')
        ? { last_sort_value: last.created_at, last_id: last.id }
        : last ? { last_sort_value: String(currentOffset + limit), last_id: last.id } : {}),
    }
  }

  // ---- leaderboard -------------------------------------------------------

  async leaderboard(params: LeaderboardParams): Promise<CursorResult<LeaderboardEntry>> {
    const limit = Math.min(Math.max(params.limit, 1), 100)

    const sortColumnMap: Record<LeaderboardParams['sort'], string> = {
      wallet_count: 'wallet_count',
      protocol_count: 'protocol_count',
      evidence_count: 'evidence_count',
      newest: 'created_at',
      tx_count: 'tx_count',
      tvl: 'tvl',
    }
    const sortColumn = sortColumnMap[params.sort] ?? 'wallet_count'

    const values: unknown[] = []
    let paramIdx = 0
    const nextParam = (): string => {
      paramIdx++
      return `$${paramIdx}`
    }

    let cursorWhere = ''
    if (params.cursorValue !== undefined && params.cursorId) {
      const cvParam = nextParam()
      const ciParam = nextParam()
      cursorWhere = `WHERE (${sortColumn}, id) < (${cvParam}, ${ciParam})`
      values.push(params.cursorValue)
      values.push(params.cursorId)
    }

    const limitParam = nextParam()
    values.push(limit + 1)

    const sql = `
      WITH ranked AS (
        SELECT ae.id, ae.display_name, ae.erc8004_id, ae.created_at,
          COUNT(DISTINCT wm.id)::int AS wallet_count,
          COUNT(DISTINCT il.id)::int AS protocol_count,
          COUNT(DISTINCT ie.id)::int AS evidence_count,
          (SELECT count(*) FROM oracle_wallet_transactions wt WHERE wt.agent_entity = ae.id)::int AS tx_count,
          (SELECT COALESCE(SUM(wb.balance_usd), 0) FROM oracle_wallet_balances wb WHERE wb.agent_entity = ae.id)::numeric AS tvl
        FROM oracle_agent_entities ae
        LEFT JOIN oracle_wallet_mappings wm ON wm.agent_entity = ae.id AND wm.removed_at IS NULL
        LEFT JOIN oracle_identity_links il ON il.agent_entity = ae.id
        LEFT JOIN oracle_identity_evidence ie ON ie.agent_entity = ae.id AND ie.revoked_at IS NULL
        GROUP BY ae.id, ae.display_name, ae.erc8004_id, ae.created_at
      )
      SELECT * FROM ranked
      ${cursorWhere}
      ORDER BY ${sortColumn} DESC, id DESC
      LIMIT ${limitParam}
    `

    const { rows } = await this.db.query(sql, values)

    const hasMore = rows.length > limit
    const trimmed = hasMore ? rows.slice(0, limit) : rows

    const data = trimmed.map((r) => ({
      id: r.id as string,
      display_name: (r.display_name as string) ?? null,
      erc8004_id: (r.erc8004_id as string) ?? null,
      wallet_count: (r.wallet_count as number) ?? 0,
      protocol_count: (r.protocol_count as number) ?? 0,
      evidence_count: (r.evidence_count as number) ?? 0,
      created_at: String(r.created_at),
    }))

    const last = data[data.length - 1]
    const lastSortValue = last ? (last as Record<string, unknown>)[sortColumn] as string | number : undefined
    return {
      data,
      has_more: hasMore,
      ...(last ? { last_sort_value: lastSortValue, last_id: last.id } : {}),
    }
  }

  // ---- getMetrics --------------------------------------------------------

  async getMetrics(id: string): Promise<AgentMetrics | null> {
    const { rows: entityRows } = await this.db.query(
      'SELECT id, created_at, updated_at FROM oracle_agent_entities WHERE id = $1',
      [id],
    )
    if (entityRows.length === 0) return null

    const entity = entityRows[0]

    const [
      walletTotalResult,
      walletByChainResult,
      walletByLinkTypeResult,
      evidenceTotalResult,
      evidenceByTypeResult,
      protocolResult,
      conflictsActiveResult,
      conflictsResolvedResult,
      lastEvidenceResult,
    ] = await Promise.all([
      // Wallets: total
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM oracle_wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL`,
        [id],
      ),
      // Wallets: by chain
      this.db.query(
        `SELECT chain, COUNT(*)::int AS cnt FROM oracle_wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL
         GROUP BY chain`,
        [id],
      ),
      // Wallets: by link_type
      this.db.query(
        `SELECT link_type, COUNT(*)::int AS cnt FROM oracle_wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL
         GROUP BY link_type`,
        [id],
      ),
      // Evidence: total (active)
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM oracle_identity_evidence
         WHERE agent_entity = $1 AND revoked_at IS NULL`,
        [id],
      ),
      // Evidence: by type (active)
      this.db.query(
        `SELECT evidence_type, COUNT(*)::int AS cnt FROM oracle_identity_evidence
         WHERE agent_entity = $1 AND revoked_at IS NULL
         GROUP BY evidence_type`,
        [id],
      ),
      // Protocols
      this.db.query(
        `SELECT protocol FROM oracle_identity_links WHERE agent_entity = $1`,
        [id],
      ),
      // Conflicts: active
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM oracle_identity_conflicts
         WHERE (existing_entity = $1 OR claiming_entity = $1) AND status = 'open'`,
        [id],
      ),
      // Conflicts: resolved
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM oracle_identity_conflicts
         WHERE (existing_entity = $1 OR claiming_entity = $1) AND status = 'resolved'`,
        [id],
      ),
      // Last evidence verified_at
      this.db.query(
        `SELECT MAX(verified_at) AS last_verified FROM oracle_identity_evidence
         WHERE agent_entity = $1 AND revoked_at IS NULL`,
        [id],
      ),
    ])

    const byChain: Record<string, number> = {}
    for (const r of walletByChainResult.rows) {
      byChain[r.chain as string] = r.cnt as number
    }

    const byLinkType: Record<string, number> = {}
    for (const r of walletByLinkTypeResult.rows) {
      byLinkType[r.link_type as string] = r.cnt as number
    }

    const byEvidenceType: Record<string, number> = {}
    for (const r of evidenceByTypeResult.rows) {
      byEvidenceType[r.evidence_type as string] = r.cnt as number
    }

    const protocolList = protocolResult.rows.map((r) => r.protocol as string)

    const lastVerified = lastEvidenceResult.rows[0]?.last_verified
    const entityUpdated = entity.updated_at
    const lastActive = lastVerified && String(lastVerified) > String(entityUpdated)
      ? String(lastVerified)
      : String(entityUpdated)

    return {
      id: entity.id as string,
      wallets: {
        total: (walletTotalResult.rows[0]?.cnt as number) ?? 0,
        by_chain: byChain,
        by_link_type: byLinkType,
      },
      evidence: {
        total: (evidenceTotalResult.rows[0]?.cnt as number) ?? 0,
        by_type: byEvidenceType,
      },
      protocols: {
        total: protocolList.length,
        list: protocolList,
      },
      conflicts: {
        active: (conflictsActiveResult.rows[0]?.cnt as number) ?? 0,
        resolved: (conflictsResolvedResult.rows[0]?.cnt as number) ?? 0,
      },
      first_seen: String(entity.created_at),
      last_active: lastActive,
    }
  }

  // ---- getActivity -------------------------------------------------------

  async getActivity(
    id: string,
    params: { limit: number; offset: number; cursorTimestamp?: string },
  ): Promise<CursorResult<ActivityEvent>> {
    const safeLimit = Math.min(Math.max(params.limit, 1), 100)

    const values: unknown[] = [id]
    let paramIdx = 1

    const cursorFilter1 = params.cursorTimestamp
      ? (() => { paramIdx++; values.push(params.cursorTimestamp); return ` AND verified_at < $${paramIdx}` })()
      : ''
    const cursorFilter2 = params.cursorTimestamp
      ? (() => { paramIdx++; values.push(params.cursorTimestamp); return ` AND created_at < $${paramIdx}` })()
      : ''
    const cursorFilter3 = params.cursorTimestamp
      ? (() => { paramIdx++; values.push(params.cursorTimestamp); return ` AND created_at < $${paramIdx}` })()
      : ''

    paramIdx++
    values.push(safeLimit + 1)
    const limitParam = `$${paramIdx}`

    const sql = `
      SELECT type, timestamp, detail FROM (
        SELECT
          'evidence_added' AS type,
          verified_at AS timestamp,
          json_build_object(
            'evidence_type', evidence_type,
            'chain', chain,
            'address', address
          ) AS detail
        FROM oracle_identity_evidence
        WHERE agent_entity = $1 AND revoked_at IS NULL${cursorFilter1}

        UNION ALL

        SELECT
          'conflict_opened' AS type,
          created_at AS timestamp,
          json_build_object(
            'chain', chain,
            'address', address,
            'role', CASE
              WHEN existing_entity = $1 THEN 'existing'
              ELSE 'claiming'
            END,
            'status', status
          ) AS detail
        FROM oracle_identity_conflicts
        WHERE (existing_entity = $1 OR claiming_entity = $1)${cursorFilter2}

        UNION ALL

        SELECT
          'wallet_linked' AS type,
          created_at AS timestamp,
          json_build_object(
            'chain', chain,
            'address', address,
            'link_type', link_type
          ) AS detail
        FROM oracle_wallet_mappings
        WHERE agent_entity = $1 AND removed_at IS NULL${cursorFilter3}
      ) AS events
      ORDER BY timestamp DESC
      LIMIT ${limitParam}
    `

    const { rows } = await this.db.query(sql, values)

    const hasMore = rows.length > safeLimit
    const trimmed = hasMore ? rows.slice(0, safeLimit) : rows

    const data = trimmed.map((r) => ({
      type: r.type as ActivityEvent['type'],
      timestamp: String(r.timestamp),
      detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
    }))

    const last = data[data.length - 1]
    return {
      data,
      has_more: hasMore,
      ...(last ? { last_sort_value: last.timestamp } : {}),
    }
  }

  // ---- getProtocol -------------------------------------------------------

  async getProtocol(id: string): Promise<ProtocolDetail | null> {
    const meta = PROTOCOL_REGISTRY[id]
    if (!meta) return null

    const [agentResult, walletResult] = await Promise.all([
      this.db.query(
        `SELECT COUNT(DISTINCT agent_entity)::int AS cnt
         FROM oracle_identity_links
         WHERE protocol = $1`,
        [id],
      ),
      this.db.query(
        `SELECT COUNT(DISTINCT wm.id)::int AS cnt
         FROM oracle_wallet_mappings wm
         JOIN oracle_identity_links il ON il.agent_entity = wm.agent_entity
         WHERE il.protocol = $1 AND wm.removed_at IS NULL`,
        [id],
      ),
    ])

    return {
      id,
      name: meta.name,
      chains: meta.chains,
      status: meta.status,
      agent_count: (agentResult.rows[0]?.cnt as number) ?? 0,
      wallet_count: (walletResult.rows[0]?.cnt as number) ?? 0,
    }
  }

  // ---- getProtocolMetrics ------------------------------------------------

  async getProtocolMetrics(id: string): Promise<ProtocolMetrics | null> {
    const meta = PROTOCOL_REGISTRY[id]
    if (!meta) return null

    const [
      agentTotalResult,
      agentByLinkTypeResult,
      walletTotalResult,
      walletByChainResult,
      evidenceTotalResult,
      evidenceByTypeResult,
      recentResult,
      conflictsResult,
    ] = await Promise.all([
      // Agents: total
      this.db.query(
        `SELECT COUNT(DISTINCT agent_entity)::int AS cnt
         FROM oracle_identity_links WHERE protocol = $1`,
        [id],
      ),
      // Agents: by link_type
      this.db.query(
        `SELECT link_type, COUNT(DISTINCT agent_entity)::int AS cnt
         FROM oracle_identity_links WHERE protocol = $1
         GROUP BY link_type`,
        [id],
      ),
      // Wallets: total
      this.db.query(
        `SELECT COUNT(DISTINCT wm.id)::int AS cnt
         FROM oracle_wallet_mappings wm
         JOIN oracle_identity_links il ON il.agent_entity = wm.agent_entity
         WHERE il.protocol = $1 AND wm.removed_at IS NULL`,
        [id],
      ),
      // Wallets: by chain
      this.db.query(
        `SELECT wm.chain, COUNT(DISTINCT wm.id)::int AS cnt
         FROM oracle_wallet_mappings wm
         JOIN oracle_identity_links il ON il.agent_entity = wm.agent_entity
         WHERE il.protocol = $1 AND wm.removed_at IS NULL
         GROUP BY wm.chain`,
        [id],
      ),
      // Evidence: total
      this.db.query(
        `SELECT COUNT(DISTINCT ie.id)::int AS cnt
         FROM oracle_identity_evidence ie
         JOIN oracle_identity_links il ON il.agent_entity = ie.agent_entity
         WHERE il.protocol = $1 AND ie.revoked_at IS NULL`,
        [id],
      ),
      // Evidence: by type
      this.db.query(
        `SELECT ie.evidence_type, COUNT(DISTINCT ie.id)::int AS cnt
         FROM oracle_identity_evidence ie
         JOIN oracle_identity_links il ON il.agent_entity = ie.agent_entity
         WHERE il.protocol = $1 AND ie.revoked_at IS NULL
         GROUP BY ie.evidence_type`,
        [id],
      ),
      // Recent registrations (7 days)
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM oracle_identity_links
         WHERE protocol = $1 AND created_at > now() - interval '7 days'`,
        [id],
      ),
      // Active conflicts for agents in this protocol
      this.db.query(
        `SELECT COUNT(DISTINCT ic.id)::int AS cnt
         FROM oracle_identity_conflicts ic
         JOIN oracle_identity_links il
           ON il.agent_entity IN (ic.existing_entity, ic.claiming_entity)
         WHERE il.protocol = $1 AND ic.status = 'open'`,
        [id],
      ),
    ])

    const agentsByLinkType: Record<string, number> = {}
    for (const r of agentByLinkTypeResult.rows) {
      agentsByLinkType[r.link_type as string] = r.cnt as number
    }

    const walletsByChain: Record<string, number> = {}
    for (const r of walletByChainResult.rows) {
      walletsByChain[r.chain as string] = r.cnt as number
    }

    const evidenceByType: Record<string, number> = {}
    for (const r of evidenceByTypeResult.rows) {
      evidenceByType[r.evidence_type as string] = r.cnt as number
    }

    return {
      id,
      name: meta.name,
      chains: meta.chains,
      status: meta.status,
      agents: {
        total: (agentTotalResult.rows[0]?.cnt as number) ?? 0,
        by_link_type: agentsByLinkType,
      },
      wallets: {
        total: (walletTotalResult.rows[0]?.cnt as number) ?? 0,
        by_chain: walletsByChain,
      },
      evidence: {
        total: (evidenceTotalResult.rows[0]?.cnt as number) ?? 0,
        by_type: evidenceByType,
      },
      recent_registrations_7d: (recentResult.rows[0]?.cnt as number) ?? 0,
      active_conflicts: (conflictsResult.rows[0]?.cnt as number) ?? 0,
    }
  }

  // ---- getAgentGraph -------------------------------------------------------

  async getAgentGraph(limit = 500): Promise<AgentGraphEdge[]> {
    const { rows } = await this.db.query(
      `SELECT
         wt.agent_entity AS from_agent,
         wm2.agent_entity AS to_agent,
         COUNT(*)::int AS tx_count,
         COALESCE(SUM(wt.amount_usd), 0)::numeric AS total_usd
       FROM oracle_wallet_transactions wt
       JOIN oracle_wallet_mappings wm2
         ON LOWER(wt.counterparty) = LOWER(wm2.address)
         AND wm2.chain = wt.chain
         AND wm2.removed_at IS NULL
       WHERE wt.direction = 'outbound'
       GROUP BY wt.agent_entity, wm2.agent_entity
       ORDER BY tx_count DESC
       LIMIT $1::int`,
      [limit],
    )

    return rows.map((r) => ({
      from_agent: r.from_agent as string,
      to_agent: r.to_agent as string,
      tx_count: r.tx_count as number,
      total_usd: Number(r.total_usd ?? 0),
    }))
  }
}
