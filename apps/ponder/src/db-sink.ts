import pg from 'pg'

let pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL required for db-sink')
  pool = new pg.Pool({ connectionString: url })
  return pool
}

/**
 * Upsert an agent entity from an ERC-8004 registration event.
 * Creates the entity if it doesn't exist, updates if it does.
 */
export async function upsertAgentFromERC8004(event: {
  agent_id: string
  owner_address: string
  tba_address: string | null
  chain: string
  tx_hash: string
  timestamp: string
}): Promise<void> {
  const db = getPool()
  const entityId = `ae_erc8004_${event.agent_id.slice(0, 16)}`

  // Upsert agent entity
  await db.query(
    `INSERT INTO oracle_agent_entities (id, display_name, erc8004_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (id) DO UPDATE SET erc8004_id = $3, updated_at = $4`,
    [entityId, `ERC-8004 Agent ${event.agent_id.slice(0, 8)}`, event.agent_id, event.timestamp],
  )

  // Add wallet mapping for owner
  await db.query(
    `INSERT INTO oracle_wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash, created_at)
     VALUES ($1, $2, $3, 'onchain_proof', 1.0, $4, $5)
     ON CONFLICT (chain, address) WHERE removed_at IS NULL DO NOTHING`,
    [entityId, event.chain, event.owner_address.toLowerCase(), event.tx_hash, event.timestamp],
  )

  // Add TBA wallet if present
  if (event.tba_address) {
    await db.query(
      `INSERT INTO oracle_wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash, created_at)
       VALUES ($1, $2, $3, 'onchain_proof', 1.0, $4, $5)
       ON CONFLICT (chain, address) WHERE removed_at IS NULL DO NOTHING`,
      [entityId, event.chain, event.tba_address.toLowerCase(), event.tx_hash, event.timestamp],
    )
  }

  // Add identity link
  await db.query(
    `INSERT INTO oracle_identity_links (agent_entity, protocol, protocol_id, link_type, confidence, evidence_json, created_at)
     VALUES ($1, 'erc8004', $2, 'onchain_proof', 1.0, $3, $4)
     ON CONFLICT (protocol, protocol_id) DO NOTHING`,
    [entityId, event.agent_id, JSON.stringify({ tx_hash: event.tx_hash, chain: event.chain }), event.timestamp],
  )
}

/**
 * Record a wallet transfer event from USDC tracking.
 */
export async function recordWalletActivity(event: {
  chain: string
  address: string
  tx_hash: string
  usd_value: number
  timestamp: string
}): Promise<void> {
  // For now just update the entity's economic output if the wallet is known
  const db = getPool()
  await db.query(
    `UPDATE oracle_agent_entities SET
       total_economic_output_usd = total_economic_output_usd + $1,
       updated_at = $2
     WHERE id IN (
       SELECT agent_entity FROM oracle_wallet_mappings
       WHERE chain = $3 AND address = $4 AND removed_at IS NULL
     )`,
    [event.usd_value, event.timestamp, event.chain, event.address.toLowerCase()],
  )
}

export async function disconnectPool(): Promise<void> {
  await pool?.end()
  pool = null
}
