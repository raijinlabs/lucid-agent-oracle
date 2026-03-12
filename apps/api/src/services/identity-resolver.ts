import { nanoid } from 'nanoid'
import type { ERC8004Event, WatchlistUpdate } from '@lucid/oracle-core'
import { TOPICS, type RedpandaProducer } from '@lucid/oracle-core'

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export class IdentityResolver {
  constructor(
    private readonly db: DbClient,
    private readonly producer: RedpandaProducer,
  ) {}

  /** Handle an ERC-8004 event from Redpanda */
  async handleERC8004Event(event: ERC8004Event): Promise<void> {
    switch (event.event_type) {
      case 'agent_registered':
        return this.handleAgentRegistered(event)
      case 'agent_updated':
        return this.handleAgentUpdated(event)
      case 'reputation_updated':
        return this.handleReputationUpdated(event)
      case 'ownership_transferred':
        return this.handleOwnershipTransferred(event)
    }
  }

  private async handleAgentRegistered(event: ERC8004Event): Promise<void> {
    // Check for existing entity
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )

    let entityId: string
    if (existing.rows.length > 0) {
      entityId = existing.rows[0].id as string
    } else {
      const id = `ae_${nanoid(12)}`
      await this.db.query(
        'INSERT INTO agent_entities (id, erc8004_id, created_at, updated_at) VALUES ($1, $2, now(), now())',
        [id, event.agent_id],
      )
      entityId = id
    }

    // Upsert TBA mapping (skip if null)
    if (event.tba_address) {
      await this.upsertWalletMapping(entityId, 'base', event.tba_address, 'erc8004_tba', event.tx_hash)
      await this.publishWatchlistUpdate('add', 'base', event.tba_address, entityId)
    }

    // Upsert owner mapping
    await this.upsertWalletMapping(entityId, 'base', event.owner_address, 'erc8004_owner', event.tx_hash)
    await this.publishWatchlistUpdate('add', 'base', event.owner_address, entityId)

    // Create identity link
    await this.db.query(
      `INSERT INTO identity_links (agent_entity, protocol, protocol_id, link_type, confidence, evidence_json)
       VALUES ($1, 'erc8004', $2, 'on_chain_proof', 1.0, $3)
       ON CONFLICT (protocol, protocol_id) DO NOTHING`,
      [entityId, event.agent_id, JSON.stringify({ tx_hash: event.tx_hash, block: event.block_number })],
    )
  }

  private async handleAgentUpdated(event: ERC8004Event): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )
    if (existing.rows.length === 0) {
      console.warn(`[resolver] AgentUpdated for unknown agent: ${event.agent_id}`)
      return
    }
    // Extract display name from raw_data if available
    try {
      const raw = JSON.parse(event.raw_data)
      if (raw.metadataUri || raw.name) {
        await this.db.query(
          'UPDATE agent_entities SET display_name = COALESCE($1, display_name), updated_at = now() WHERE id = $2',
          [raw.name ?? raw.metadataUri, existing.rows[0].id],
        )
      }
    } catch {
      // Skip metadata parse errors
    }
  }

  private async handleReputationUpdated(event: ERC8004Event): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )
    if (existing.rows.length === 0) {
      console.warn(`[resolver] ReputationUpdated for unknown agent: ${event.agent_id}`)
      return
    }
    await this.db.query(
      `UPDATE agent_entities SET reputation_json = $1, reputation_updated_at = now(), updated_at = now() WHERE id = $2`,
      [JSON.stringify({ score: event.reputation_score, validator: event.validator_address, evidence: event.evidence_hash }), existing.rows[0].id],
    )
  }

  private async handleOwnershipTransferred(event: ERC8004Event): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )
    if (existing.rows.length === 0) {
      console.warn(`[resolver] OwnershipTransferred for unknown agent: ${event.agent_id}`)
      return
    }
    const entityId = existing.rows[0].id as string

    // Extract old owner from raw_data
    let oldOwner: string | null = null
    try {
      const raw = JSON.parse(event.raw_data)
      oldOwner = raw.old_owner ?? raw.previousOwner ?? null
    } catch { /* skip */ }

    // Soft-delete old owner mapping
    if (oldOwner) {
      await this.db.query(
        `UPDATE wallet_mappings SET removed_at = now() WHERE chain = 'base' AND LOWER(address) = LOWER($1) AND removed_at IS NULL`,
        [oldOwner],
      )
      await this.publishWatchlistUpdate('remove', 'base', oldOwner, entityId)
    }

    // Add new owner mapping
    await this.upsertWalletMapping(entityId, 'base', event.owner_address, 'erc8004_owner', event.tx_hash)
    await this.publishWatchlistUpdate('add', 'base', event.owner_address, entityId)
  }

  private async upsertWalletMapping(
    entityId: string,
    chain: string,
    address: string,
    linkType: string,
    txHash: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash)
       VALUES ($1, $2, $3, $4, 1.0, $5)
       ON CONFLICT (chain, address) WHERE removed_at IS NULL DO UPDATE SET
         agent_entity = EXCLUDED.agent_entity,
         link_type = EXCLUDED.link_type,
         evidence_hash = EXCLUDED.evidence_hash`,
      [entityId, chain, address, linkType, txHash],
    )
  }

  private async publishWatchlistUpdate(
    action: 'add' | 'remove',
    chain: 'base' | 'solana',
    address: string,
    entityId: string,
  ): Promise<void> {
    const update: WatchlistUpdate = { action, chain, address, agent_entity_id: entityId }
    await this.producer.publishJson(TOPICS.WATCHLIST, `${chain}:${address}`, update)
  }
}
