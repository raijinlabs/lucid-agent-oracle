import { nanoid } from 'nanoid'
import type { DbClient, RedpandaProducer } from '@lucid/oracle-core'
import { TOPICS } from '@lucid/oracle-core'

interface ResolverResult {
  skipped: boolean
  processed: number
  created: number
  enriched: number
  conflicts: number
}

export class LucidResolver {
  constructor(
    private readonly db: DbClient,
    private readonly producer: RedpandaProducer,
  ) {}

  async run(): Promise<ResolverResult> {
    // Acquire advisory lock
    const { rows: lockRows } = await this.db.query(
      "SELECT pg_try_advisory_lock(hashtext('lucid_resolver'))",
    )
    if (!lockRows[0]?.pg_try_advisory_lock) {
      return { skipped: true, processed: 0, created: 0, enriched: 0, conflicts: 0 }
    }

    const result: ResolverResult = { skipped: false, processed: 0, created: 0, enriched: 0, conflicts: 0 }

    try {
      // Query tenants with payment_config.wallets
      const { rows: tenants } = await this.db.query(
        `SELECT id, payment_config FROM gateway_tenants
         WHERE payment_config IS NOT NULL
         AND payment_config::jsonb->'wallets' IS NOT NULL`,
      )

      for (const tenant of tenants) {
        const config = typeof tenant.payment_config === 'string'
          ? JSON.parse(tenant.payment_config as string)
          : tenant.payment_config
        const wallets = config?.wallets as Array<{ chain: string; address: string }> | undefined
        if (!wallets || wallets.length === 0) continue

        await this.resolveTenant(tenant.id as string, wallets, result)
        result.processed++
      }
    } finally {
      // Release advisory lock
      await this.db.query("SELECT pg_advisory_unlock(hashtext('lucid_resolver'))").catch(() => {})
    }

    return result
  }

  private async resolveTenant(
    tenantId: string,
    wallets: Array<{ chain: string; address: string }>,
    result: ResolverResult,
  ): Promise<void> {
    await this.db.query('BEGIN')

    try {
      // Find or create entity
      let entityId: string

      // Check if entity already exists for this tenant
      const { rows: existingEntity } = await this.db.query(
        'SELECT id FROM agent_entities WHERE lucid_tenant = $1',
        [tenantId],
      )

      if (existingEntity.length > 0) {
        entityId = existingEntity[0].id as string
      } else {
        // Check if any wallet already maps to an ERC-8004 entity
        let foundErc8004Entity: string | null = null
        for (const w of wallets) {
          const { rows: mapped } = await this.db.query(
            `SELECT agent_entity FROM wallet_mappings
             WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
            [w.chain, w.address],
          )
          if (mapped.length > 0) {
            foundErc8004Entity = mapped[0].agent_entity as string
            break
          }
        }

        if (foundErc8004Entity) {
          // Cross-source merge: enrich existing ERC-8004 entity
          const { rows: enriched } = await this.db.query(
            `UPDATE agent_entities SET lucid_tenant = $1, updated_at = now()
             WHERE id = $2 AND lucid_tenant IS NULL
             RETURNING id`,
            [tenantId, foundErc8004Entity],
          )
          if (enriched.length === 0) {
            // Entity already has a different lucid_tenant — skip enrichment, create new entity instead
            console.warn(`[lucid-resolver] Entity ${foundErc8004Entity} already has a lucid_tenant, creating new entity for tenant ${tenantId}`)
            entityId = `ae_${nanoid()}`
            await this.db.query(
              'INSERT INTO agent_entities (id, lucid_tenant, created_at, updated_at) VALUES ($1, $2, now(), now())',
              [entityId, tenantId],
            )
            result.created++
          } else {
            entityId = foundErc8004Entity
            result.enriched++
          }
        } else {
          // Create new entity
          entityId = `ae_${nanoid()}`
          await this.db.query(
            'INSERT INTO agent_entities (id, lucid_tenant, created_at, updated_at) VALUES ($1, $2, now(), now())',
            [entityId, tenantId],
          )
          result.created++
        }
      }

      // Process each wallet
      const newSolanaWallets: string[] = []

      for (const w of wallets) {
        // Insert evidence (with dedup via ON CONFLICT DO NOTHING RETURNING id)
        const { rows: evidenceRows } = await this.db.query(
          `INSERT INTO identity_evidence
           (agent_entity, evidence_type, chain, address, metadata_json)
           VALUES ($1, 'gateway_correlation', $2, $3, $4)
           ON CONFLICT (agent_entity, evidence_type, chain, address)
           WHERE evidence_type = 'gateway_correlation' AND revoked_at IS NULL
           DO NOTHING
           RETURNING id`,
          [entityId, w.chain, w.address, JSON.stringify({ tenant_id: tenantId, source: 'payment_config' })],
        )

        let evidenceId: number
        if (evidenceRows.length > 0) {
          evidenceId = evidenceRows[0].id as number
        } else {
          // Fallback: SELECT existing evidence id
          const { rows: existing } = await this.db.query(
            `SELECT id FROM identity_evidence
             WHERE agent_entity = $1 AND evidence_type = 'gateway_correlation'
             AND chain = $2 AND LOWER(address) = LOWER($3) AND revoked_at IS NULL`,
            [entityId, w.chain, w.address],
          )
          if (!existing[0]?.id) {
            console.warn(`[lucid-resolver] Evidence dedup fallback returned no rows for ${w.chain}:${w.address}`)
            continue // skip this wallet — evidence dedup issue
          }
          evidenceId = existing[0].id as number
        }

        // Check wallet mapping
        const { rows: existingMapping } = await this.db.query(
          `SELECT agent_entity, confidence FROM wallet_mappings
           WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
          [w.chain, w.address],
        )

        if (existingMapping.length === 0) {
          // Not mapped — insert
          await this.db.query(
            `INSERT INTO wallet_mappings
             (agent_entity, chain, address, link_type, confidence, evidence_hash)
             VALUES ($1, $2, $3, 'lucid_passport', 1.0, NULL)`,
            [entityId, w.chain, w.address],
          )
          if (w.chain === 'solana') newSolanaWallets.push(w.address)
        } else if (existingMapping[0].agent_entity !== entityId) {
          // Mapped to different entity — conflict
          await this.db.query(
            `INSERT INTO identity_conflicts
             (chain, address, existing_entity, claiming_entity, existing_confidence, claiming_confidence, claim_evidence_id)
             VALUES ($1, $2, $3, $4, $5, 1.0, $6)`,
            [w.chain, w.address, existingMapping[0].agent_entity, entityId, existingMapping[0].confidence, evidenceId],
          )
          result.conflicts++
        }
        // If same entity — skip (idempotent)
      }

      // Upsert identity_link
      await this.db.query(
        `INSERT INTO identity_links (agent_entity, protocol, protocol_id, link_type, confidence)
         VALUES ($1, 'lucid', $2, 'gateway_correlation', 1.0)
         ON CONFLICT (protocol, protocol_id) DO NOTHING`,
        [entityId, tenantId],
      )

      await this.db.query('COMMIT')

      // Publish watchlist updates (after commit)
      for (const addr of newSolanaWallets) {
        await this.producer.publishJson(TOPICS.WATCHLIST, `watchlist:solana`, {
          action: 'add',
          chain: 'solana',
          address: addr,
          agent_entity_id: entityId,
        }).catch(() => {})
      }
    } catch (err) {
      await this.db.query('ROLLBACK').catch(() => {})
      throw err
    }
  }
}
