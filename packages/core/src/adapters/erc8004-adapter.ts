import { nanoid } from 'nanoid'
import type { AdapterDefinition, IdentityHandler, DbClient } from './adapter-types.js'
import type { RedpandaProducer } from '../clients/redpanda.js'
import { TOPICS } from '../clients/redpanda.js'

/**
 * ERC-8004 Identity Handler — processes real events from Base mainnet.
 *
 * Events (from resolved staging row):
 *   agent_registered: { agent_id, agent_uri, owner_address }
 *   uri_updated:      { agent_id, agent_uri, owner_address }
 *   metadata_set:     { agent_id, key_hash, value }
 *   ownership_transferred: { agent_id, previous_owner, new_owner }
 *
 * All events also carry: event_type, tx_hash, block_number, chain, source
 */

const erc8004IdentityHandler: IdentityHandler = {
  handles: ['agent_registered', 'uri_updated', 'metadata_set', 'ownership_transferred', 'new_feedback'],

  async handleEvent(
    raw: Record<string, unknown>,
    db: DbClient,
    producer: RedpandaProducer | null,
  ): Promise<void> {
    const event = raw as Record<string, any>

    switch (event.event_type) {
      case 'agent_registered':
        return handleAgentRegistered(event, db, producer)
      case 'uri_updated':
        return handleURIUpdated(event, db)
      case 'metadata_set':
        return handleMetadataSet(event, db, producer)
      case 'ownership_transferred':
        return handleOwnershipTransferred(event, db, producer)
      case 'new_feedback':
        return handleNewFeedback(event, db)
    }
  },
}

async function getOrCreateEntity(
  db: DbClient,
  agentId: string,
): Promise<string> {
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [agentId],
  )
  if (existing.rows.length > 0) return existing.rows[0].id as string

  const id = `ae_${nanoid(12)}`
  await db.query(
    'INSERT INTO oracle_agent_entities (id, erc8004_id, created_at, updated_at) VALUES ($1, $2, now(), now())',
    [id, agentId],
  )
  return id
}

async function handleAgentRegistered(
  event: Record<string, any>,
  db: DbClient,
  producer: RedpandaProducer | null,
): Promise<void> {
  const agentId = String(event.agent_id)
  const entityId = await getOrCreateEntity(db, agentId)

  // Store agent_uri on the entity
  if (event.agent_uri) {
    await db.query(
      'UPDATE oracle_agent_entities SET agent_uri = $1, updated_at = now() WHERE id = $2',
      [event.agent_uri, entityId],
    )
  }

  // Map owner wallet
  if (event.owner_address) {
    await upsertWalletMapping(db, entityId, 'base', event.owner_address, 'onchain_proof', event.tx_hash ?? '')
    await publishWatchlistUpdate(producer, 'add', 'base', event.owner_address, entityId)
  }

  // Identity link
  await db.query(
    `INSERT INTO oracle_identity_links (agent_entity, protocol, protocol_id, link_type, confidence, evidence_json)
     VALUES ($1, 'erc8004', $2, 'onchain_proof', 1.0, $3)
     ON CONFLICT (protocol, protocol_id) DO NOTHING`,
    [entityId, agentId, JSON.stringify({ tx_hash: event.tx_hash, block: event.block_number })],
  )
}

async function handleURIUpdated(
  event: Record<string, any>,
  db: DbClient,
): Promise<void> {
  const agentId = String(event.agent_id)
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [agentId],
  )
  if (existing.rows.length === 0) return

  await db.query(
    'UPDATE oracle_agent_entities SET agent_uri = $1, updated_at = now() WHERE id = $2',
    [event.agent_uri, existing.rows[0].id],
  )
}

/**
 * Decode an Ethereum address from ABI-encoded bytes.
 * The data field is hex-encoded, address is last 20 bytes (left-padded to 32).
 */
function decodeAddressFromBytes(hexData: string): string | null {
  const clean = hexData.replace(/^0x/, '')
  if (clean.length < 40) return null
  const addr = '0x' + clean.slice(-40).toLowerCase()
  if (addr === '0x' + '0'.repeat(40)) return null // zero address
  return addr
}

/**
 * Decode a UTF-8 string from ABI-encoded bytes.
 * For simple cases: strip zero-padding and decode hex to string.
 */
function decodeBytesToString(hexData: string): string {
  const clean = hexData.replace(/^0x/, '')
  // Try direct UTF-8 decode (strip trailing zeros)
  const bytes = Buffer.from(clean, 'hex')
  // Find first null byte or end
  let end = bytes.length
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) { end = i; break }
  }
  return bytes.subarray(0, end).toString('utf8').trim()
}

async function handleMetadataSet(
  event: Record<string, any>,
  db: DbClient,
  producer: RedpandaProducer | null,
): Promise<void> {
  const agentId = String(event.agent_id)
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [agentId],
  )
  if (existing.rows.length === 0) return
  const entityId = existing.rows[0].id as string

  const keyName = event.value ?? '' // key name string (e.g. "agentWallet")
  const data = event.data as string | undefined

  // agentWallet: decode address from bytes → create wallet mapping
  if (keyName === 'agentWallet' && data && data.length > 2) {
    const walletAddress = decodeAddressFromBytes(data)
    if (walletAddress) {
      await upsertWalletMapping(db, entityId, 'base', walletAddress, 'onchain_proof', event.tx_hash ?? '')
      await publishWatchlistUpdate(producer, 'add', 'base', walletAddress, entityId)
    }
  }

  // Decode the data field for storage
  let decodedValue = ''
  if (data && data.length > 2) {
    if (keyName === 'agentWallet' || keyName === 'serviceRegistry') {
      decodedValue = decodeAddressFromBytes(data) ?? data
    } else if (keyName === 'ecosystem') {
      decodedValue = decodeBytesToString(data) || data
    } else if (keyName === 'serviceId') {
      // serviceId is a uint256 encoded as bytes
      const n = parseInt(data.replace(/^0x0*/, ''), 16)
      decodedValue = isNaN(n) ? data : String(n)
    } else {
      decodedValue = data
    }
  }

  // Store in metadata_json keyed by human-readable name
  await db.query(
    `UPDATE oracle_agent_entities
     SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object($1, $2),
         updated_at = now()
     WHERE id = $3`,
    [keyName || event.key_hash || 'unknown', decodedValue, entityId],
  )
}

async function handleOwnershipTransferred(
  event: Record<string, any>,
  db: DbClient,
  producer: RedpandaProducer | null,
): Promise<void> {
  const agentId = String(event.agent_id)
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [agentId],
  )
  if (existing.rows.length === 0) return
  const entityId = existing.rows[0].id as string

  // Soft-delete old owner's wallet mapping
  if (event.previous_owner) {
    await db.query(
      `UPDATE oracle_wallet_mappings SET removed_at = now()
       WHERE chain = 'base' AND LOWER(address) = LOWER($1) AND removed_at IS NULL`,
      [event.previous_owner],
    )
    await publishWatchlistUpdate(producer, 'remove', 'base', event.previous_owner, entityId)
  }

  // Add new owner's wallet mapping
  if (event.new_owner) {
    await upsertWalletMapping(db, entityId, 'base', event.new_owner, 'onchain_proof', event.tx_hash ?? '')
    await publishWatchlistUpdate(producer, 'add', 'base', event.new_owner, entityId)
  }
}

async function handleNewFeedback(
  event: Record<string, any>,
  db: DbClient,
): Promise<void> {
  const agentId = String(event.agent_id)
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [agentId],
  )
  if (existing.rows.length === 0) return
  const entityId = existing.rows[0].id as string

  // Store feedback in oracle_agent_feedback
  await db.query(
    `INSERT INTO oracle_agent_feedback
     (agent_entity, chain, client_address, feedback_index, value, value_decimals,
      tag1, tag2, endpoint, feedback_uri, feedback_hash, tx_hash, block_number, event_timestamp)
     VALUES ($1, 'base', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (agent_entity, chain, feedback_index) DO NOTHING`,
    [entityId, event.client_address, event.feedback_index, event.value, event.value_decimals,
     event.tag1, event.tag2, event.endpoint, event.feedback_uri, event.feedback_hash,
     event.tx_hash, event.block_number, event.timestamp],
  )

  // Update agent's reputation summary
  await db.query(
    `UPDATE oracle_agent_entities
     SET reputation_json = (
       SELECT jsonb_build_object(
         'feedback_count', count(*),
         'avg_value', round(avg(value)::numeric, 2),
         'latest_tag1', (SELECT tag1 FROM oracle_agent_feedback WHERE agent_entity = $1 ORDER BY event_timestamp DESC LIMIT 1),
         'latest_tag2', (SELECT tag2 FROM oracle_agent_feedback WHERE agent_entity = $1 ORDER BY event_timestamp DESC LIMIT 1)
       ) FROM oracle_agent_feedback WHERE agent_entity = $1
     ),
     reputation_updated_at = now(),
     updated_at = now()
     WHERE id = $1`,
    [entityId],
  )
}

async function upsertWalletMapping(
  db: DbClient,
  entityId: string,
  chain: string,
  address: string,
  linkType: string,
  txHash: string,
): Promise<void> {
  await db.query(
    `INSERT INTO oracle_wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash)
     VALUES ($1, $2, $3, $4, 1.0, $5)
     ON CONFLICT (chain, address) WHERE removed_at IS NULL DO UPDATE SET
       agent_entity = EXCLUDED.agent_entity,
       link_type = EXCLUDED.link_type,
       evidence_hash = EXCLUDED.evidence_hash`,
    [entityId, chain, address, linkType, txHash],
  )
}

async function publishWatchlistUpdate(
  producer: RedpandaProducer | null,
  action: 'add' | 'remove',
  chain: 'base' | 'solana',
  address: string,
  entityId: string,
): Promise<void> {
  if (!producer) return
  await producer.publishJson(TOPICS.WATCHLIST, `${chain}:${address}`, {
    action, chain, address, agent_entity_id: entityId,
  })
}

/** ERC-8004 adapter — indexes agent identity registry events on Base */
export const erc8004Adapter: AdapterDefinition = {
  source: 'erc8004',
  version: 2,
  description: 'ERC-8004 Agent Identity Registry on Base',
  topic: TOPICS.RAW_ERC8004,
  chains: ['base'],
  identity: erc8004IdentityHandler,
}
