import { nanoid } from 'nanoid'
import type { AdapterDefinition, IdentityHandler, DbClient } from './adapter-types.js'
import type { RedpandaProducer } from '../clients/redpanda.js'
import type { ERC8004Event, WatchlistUpdate } from '../types/identity.js'
import { TOPICS } from '../clients/redpanda.js'

/** Identity handler for ERC-8004 events — creates entities, wallets, and links */
const erc8004IdentityHandler: IdentityHandler = {
  handles: ['agent_registered', 'agent_updated', 'ownership_transferred', 'reputation_updated'],

  async handleEvent(
    raw: Record<string, unknown>,
    db: DbClient,
    producer: RedpandaProducer,
  ): Promise<void> {
    const event = raw as unknown as ERC8004Event

    switch (event.event_type) {
      case 'agent_registered':
        return handleAgentRegistered(event, db, producer)
      case 'agent_updated':
        return handleAgentUpdated(event, db)
      case 'reputation_updated':
        return handleReputationUpdated(event, db)
      case 'ownership_transferred':
        return handleOwnershipTransferred(event, db, producer)
    }
  },
}

async function handleAgentRegistered(
  event: ERC8004Event,
  db: DbClient,
  producer: RedpandaProducer,
): Promise<void> {
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [event.agent_id],
  )

  let entityId: string
  if (existing.rows.length > 0) {
    entityId = existing.rows[0].id as string
  } else {
    const id = `ae_${nanoid(12)}`
    await db.query(
      'INSERT INTO oracle_agent_entities (id, erc8004_id, created_at, updated_at) VALUES ($1, $2, now(), now())',
      [id, event.agent_id],
    )
    entityId = id
  }

  if (event.tba_address) {
    await upsertWalletMapping(db, entityId, 'base', event.tba_address, 'erc8004_tba', event.tx_hash)
    await publishWatchlistUpdate(producer, 'add', 'base', event.tba_address, entityId)
  }

  await upsertWalletMapping(db, entityId, 'base', event.owner_address, 'erc8004_owner', event.tx_hash)
  await publishWatchlistUpdate(producer, 'add', 'base', event.owner_address, entityId)

  await db.query(
    `INSERT INTO oracle_identity_links (agent_entity, protocol, protocol_id, link_type, confidence, evidence_json)
     VALUES ($1, 'erc8004', $2, 'on_chain_proof', 1.0, $3)
     ON CONFLICT (protocol, protocol_id) DO NOTHING`,
    [entityId, event.agent_id, JSON.stringify({ tx_hash: event.tx_hash, block: event.block_number })],
  )
}

async function handleAgentUpdated(event: ERC8004Event, db: DbClient): Promise<void> {
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [event.agent_id],
  )
  if (existing.rows.length === 0) {
    console.warn(`[resolver] AgentUpdated for unknown agent: ${event.agent_id}`)
    return
  }
  try {
    const raw = JSON.parse(event.raw_data)
    if (raw.metadataUri || raw.name) {
      await db.query(
        'UPDATE oracle_agent_entities SET display_name = COALESCE($1, display_name), updated_at = now() WHERE id = $2',
        [raw.name ?? raw.metadataUri, existing.rows[0].id],
      )
    }
  } catch {
    // Skip metadata parse errors
  }
}

async function handleReputationUpdated(event: ERC8004Event, db: DbClient): Promise<void> {
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [event.agent_id],
  )
  if (existing.rows.length === 0) {
    console.warn(`[resolver] ReputationUpdated for unknown agent: ${event.agent_id}`)
    return
  }
  await db.query(
    `UPDATE oracle_agent_entities SET reputation_json = $1, reputation_updated_at = now(), updated_at = now() WHERE id = $2`,
    [JSON.stringify({ score: event.reputation_score, validator: event.validator_address, evidence: event.evidence_hash }), existing.rows[0].id],
  )
}

async function handleOwnershipTransferred(
  event: ERC8004Event,
  db: DbClient,
  producer: RedpandaProducer,
): Promise<void> {
  const existing = await db.query(
    'SELECT id FROM oracle_agent_entities WHERE erc8004_id = $1',
    [event.agent_id],
  )
  if (existing.rows.length === 0) {
    console.warn(`[resolver] OwnershipTransferred for unknown agent: ${event.agent_id}`)
    return
  }
  const entityId = existing.rows[0].id as string

  let oldOwner: string | null = null
  try {
    const raw = JSON.parse(event.raw_data)
    oldOwner = raw.old_owner ?? raw.previousOwner ?? null
  } catch { /* skip */ }

  if (oldOwner) {
    await db.query(
      `UPDATE oracle_wallet_mappings SET removed_at = now() WHERE chain = 'base' AND LOWER(address) = LOWER($1) AND removed_at IS NULL`,
      [oldOwner],
    )
    await publishWatchlistUpdate(producer, 'remove', 'base', oldOwner, entityId)
  }

  await upsertWalletMapping(db, entityId, 'base', event.owner_address, 'erc8004_owner', event.tx_hash)
  await publishWatchlistUpdate(producer, 'add', 'base', event.owner_address, entityId)
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
  if (!producer) return // No-broker mode — watchlist refresh via Redis or timer
  const update: WatchlistUpdate = { action, chain, address, agent_entity_id: entityId }
  await producer.publishJson(TOPICS.WATCHLIST, `${chain}:${address}`, update)
}

/** ERC-8004 adapter — indexes agent identity registry events on Base */
export const erc8004Adapter: AdapterDefinition = {
  source: 'erc8004',
  version: 1,
  description: 'ERC-8004 Agent Identity Registry on Base',
  topic: TOPICS.RAW_ERC8004,
  chains: ['base'],
  identity: erc8004IdentityHandler,
  // No webhook — events come from Ponder indexer
}
