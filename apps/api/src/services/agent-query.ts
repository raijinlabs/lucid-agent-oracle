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
  reputation_json: Record<string, unknown> | null
  reputation_updated_at: string | null
  created_at: string
  updated_at: string
  wallets: Array<{ chain: string; address: string; link_type: string; confidence: number }>
  identity_links: Array<{ protocol: string; protocol_id: string; link_type: string; confidence: number }>
  evidence_count: number
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
  limit: number
  offset: number
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
  sort: 'wallet_count' | 'protocol_count' | 'evidence_count' | 'newest'
  limit: number
  offset: number
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
      'SELECT 1 FROM agent_entities WHERE id = $1',
      [id],
    )
    return rows.length > 0
  }

  // ---- getProfile --------------------------------------------------------

  async getProfile(id: string): Promise<AgentProfile | null> {
    const { rows: entityRows } = await this.db.query(
      'SELECT * FROM agent_entities WHERE id = $1',
      [id],
    )
    if (entityRows.length === 0) return null

    const entity = entityRows[0]

    const [walletResult, linkResult, evidenceResult] = await Promise.all([
      this.db.query(
        `SELECT chain, address, link_type, confidence
         FROM wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL
         ORDER BY created_at`,
        [id],
      ),
      this.db.query(
        `SELECT protocol, protocol_id, link_type, confidence
         FROM identity_links
         WHERE agent_entity = $1
         ORDER BY created_at`,
        [id],
      ),
      this.db.query(
        `SELECT COUNT(*)::int AS cnt
         FROM identity_evidence
         WHERE agent_entity = $1 AND revoked_at IS NULL`,
        [id],
      ),
    ])

    return {
      id: entity.id as string,
      display_name: (entity.display_name as string) ?? null,
      erc8004_id: (entity.erc8004_id as string) ?? null,
      lucid_tenant: (entity.lucid_tenant as string) ?? null,
      reputation_json: (entity.reputation_json as Record<string, unknown>) ?? null,
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
      evidence_count: (evidenceResult.rows[0]?.cnt as number) ?? 0,
    }
  }

  // ---- search ------------------------------------------------------------

  async search(params: SearchParams): Promise<{ agents: AgentSearchResult[]; total: number }> {
    const limit = Math.min(Math.max(params.limit, 1), 100)
    const offset = Math.max(params.offset, 0)

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
        'JOIN wallet_mappings wm ON wm.agent_entity = ae.id AND wm.removed_at IS NULL',
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
        'JOIN identity_links il ON il.agent_entity = ae.id',
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

    if (params.q) {
      conditions.push(`ae.display_name ILIKE ${nextParam()}`)
      values.push(`%${params.q}%`)
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : ''
    const joinClause = joins.join(' ')

    // Count query
    const countSql = `SELECT COUNT(DISTINCT ae.id)::int AS cnt FROM agent_entities ae ${joinClause} ${whereClause}`
    const { rows: countRows } = await this.db.query(countSql, values)
    const total = (countRows[0]?.cnt as number) ?? 0

    if (total === 0) {
      return { agents: [], total: 0 }
    }

    // Data query
    const limitParam = nextParam()
    values.push(limit)
    const offsetParam = nextParam()
    values.push(offset)

    const dataSql = `SELECT DISTINCT ae.id, ae.display_name, ae.erc8004_id, ae.created_at
      FROM agent_entities ae ${joinClause} ${whereClause}
      ORDER BY ae.created_at DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`

    const { rows } = await this.db.query(dataSql, values)

    return {
      agents: rows.map((r) => ({
        id: r.id as string,
        display_name: (r.display_name as string) ?? null,
        erc8004_id: (r.erc8004_id as string) ?? null,
        created_at: String(r.created_at),
      })),
      total,
    }
  }

  // ---- leaderboard -------------------------------------------------------

  async leaderboard(params: LeaderboardParams): Promise<{ agents: LeaderboardEntry[]; total: number }> {
    const limit = Math.min(Math.max(params.limit, 1), 100)
    const offset = Math.max(params.offset, 0)

    const orderByMap: Record<LeaderboardParams['sort'], string> = {
      wallet_count: 'wallet_count DESC',
      protocol_count: 'protocol_count DESC',
      evidence_count: 'evidence_count DESC',
      newest: 'ae.created_at DESC',
    }
    const orderBy = orderByMap[params.sort] ?? 'wallet_count DESC'

    // Count total agents
    const { rows: countRows } = await this.db.query(
      'SELECT COUNT(*)::int AS cnt FROM agent_entities',
    )
    const total = (countRows[0]?.cnt as number) ?? 0

    if (total === 0) {
      return { agents: [], total: 0 }
    }

    const sql = `
      SELECT
        ae.id,
        ae.display_name,
        ae.erc8004_id,
        ae.created_at,
        COUNT(DISTINCT wm.id)::int AS wallet_count,
        COUNT(DISTINCT il.id)::int AS protocol_count,
        COUNT(DISTINCT ie.id)::int AS evidence_count
      FROM agent_entities ae
      LEFT JOIN wallet_mappings wm
        ON wm.agent_entity = ae.id AND wm.removed_at IS NULL
      LEFT JOIN identity_links il
        ON il.agent_entity = ae.id
      LEFT JOIN identity_evidence ie
        ON ie.agent_entity = ae.id AND ie.revoked_at IS NULL
      GROUP BY ae.id, ae.display_name, ae.erc8004_id, ae.created_at
      ORDER BY ${orderBy}
      LIMIT $1 OFFSET $2
    `

    const { rows } = await this.db.query(sql, [limit, offset])

    return {
      agents: rows.map((r) => ({
        id: r.id as string,
        display_name: (r.display_name as string) ?? null,
        erc8004_id: (r.erc8004_id as string) ?? null,
        wallet_count: (r.wallet_count as number) ?? 0,
        protocol_count: (r.protocol_count as number) ?? 0,
        evidence_count: (r.evidence_count as number) ?? 0,
        created_at: String(r.created_at),
      })),
      total,
    }
  }

  // ---- getMetrics --------------------------------------------------------

  async getMetrics(id: string): Promise<AgentMetrics | null> {
    const { rows: entityRows } = await this.db.query(
      'SELECT id, created_at, updated_at FROM agent_entities WHERE id = $1',
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
        `SELECT COUNT(*)::int AS cnt FROM wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL`,
        [id],
      ),
      // Wallets: by chain
      this.db.query(
        `SELECT chain, COUNT(*)::int AS cnt FROM wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL
         GROUP BY chain`,
        [id],
      ),
      // Wallets: by link_type
      this.db.query(
        `SELECT link_type, COUNT(*)::int AS cnt FROM wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL
         GROUP BY link_type`,
        [id],
      ),
      // Evidence: total (active)
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM identity_evidence
         WHERE agent_entity = $1 AND revoked_at IS NULL`,
        [id],
      ),
      // Evidence: by type (active)
      this.db.query(
        `SELECT evidence_type, COUNT(*)::int AS cnt FROM identity_evidence
         WHERE agent_entity = $1 AND revoked_at IS NULL
         GROUP BY evidence_type`,
        [id],
      ),
      // Protocols
      this.db.query(
        `SELECT protocol FROM identity_links WHERE agent_entity = $1`,
        [id],
      ),
      // Conflicts: active
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM identity_conflicts
         WHERE (existing_entity = $1 OR claiming_entity = $1) AND status = 'open'`,
        [id],
      ),
      // Conflicts: resolved
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM identity_conflicts
         WHERE (existing_entity = $1 OR claiming_entity = $1) AND status = 'resolved'`,
        [id],
      ),
      // Last evidence verified_at
      this.db.query(
        `SELECT MAX(verified_at) AS last_verified FROM identity_evidence
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
    params: { limit: number; offset: number },
  ): Promise<{ events: ActivityEvent[] }> {
    const safeLimit = Math.min(Math.max(params.limit, 1), 100)
    const safeOffset = Math.max(params.offset, 0)

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
        FROM identity_evidence
        WHERE agent_entity = $1 AND revoked_at IS NULL

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
        FROM identity_conflicts
        WHERE existing_entity = $1 OR claiming_entity = $1

        UNION ALL

        SELECT
          'wallet_linked' AS type,
          created_at AS timestamp,
          json_build_object(
            'chain', chain,
            'address', address,
            'link_type', link_type
          ) AS detail
        FROM wallet_mappings
        WHERE agent_entity = $1 AND removed_at IS NULL
      ) AS events
      ORDER BY timestamp DESC
      LIMIT $2 OFFSET $3
    `

    const { rows } = await this.db.query(sql, [id, safeLimit, safeOffset])

    return {
      events: rows.map((r) => ({
        type: r.type as ActivityEvent['type'],
        timestamp: String(r.timestamp),
        detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
      })),
    }
  }

  // ---- getProtocol -------------------------------------------------------

  async getProtocol(id: string): Promise<ProtocolDetail | null> {
    const meta = PROTOCOL_REGISTRY[id]
    if (!meta) return null

    const [agentResult, walletResult] = await Promise.all([
      this.db.query(
        `SELECT COUNT(DISTINCT agent_entity)::int AS cnt
         FROM identity_links
         WHERE protocol = $1`,
        [id],
      ),
      this.db.query(
        `SELECT COUNT(DISTINCT wm.id)::int AS cnt
         FROM wallet_mappings wm
         JOIN identity_links il ON il.agent_entity = wm.agent_entity
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
         FROM identity_links WHERE protocol = $1`,
        [id],
      ),
      // Agents: by link_type
      this.db.query(
        `SELECT link_type, COUNT(DISTINCT agent_entity)::int AS cnt
         FROM identity_links WHERE protocol = $1
         GROUP BY link_type`,
        [id],
      ),
      // Wallets: total
      this.db.query(
        `SELECT COUNT(DISTINCT wm.id)::int AS cnt
         FROM wallet_mappings wm
         JOIN identity_links il ON il.agent_entity = wm.agent_entity
         WHERE il.protocol = $1 AND wm.removed_at IS NULL`,
        [id],
      ),
      // Wallets: by chain
      this.db.query(
        `SELECT wm.chain, COUNT(DISTINCT wm.id)::int AS cnt
         FROM wallet_mappings wm
         JOIN identity_links il ON il.agent_entity = wm.agent_entity
         WHERE il.protocol = $1 AND wm.removed_at IS NULL
         GROUP BY wm.chain`,
        [id],
      ),
      // Evidence: total
      this.db.query(
        `SELECT COUNT(DISTINCT ie.id)::int AS cnt
         FROM identity_evidence ie
         JOIN identity_links il ON il.agent_entity = ie.agent_entity
         WHERE il.protocol = $1 AND ie.revoked_at IS NULL`,
        [id],
      ),
      // Evidence: by type
      this.db.query(
        `SELECT ie.evidence_type, COUNT(DISTINCT ie.id)::int AS cnt
         FROM identity_evidence ie
         JOIN identity_links il ON il.agent_entity = ie.agent_entity
         WHERE il.protocol = $1 AND ie.revoked_at IS NULL
         GROUP BY ie.evidence_type`,
        [id],
      ),
      // Recent registrations (7 days)
      this.db.query(
        `SELECT COUNT(*)::int AS cnt FROM identity_links
         WHERE protocol = $1 AND created_at > now() - interval '7 days'`,
        [id],
      ),
      // Active conflicts for agents in this protocol
      this.db.query(
        `SELECT COUNT(DISTINCT ic.id)::int AS cnt
         FROM identity_conflicts ic
         JOIN identity_links il
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
}
