import { nanoid } from 'nanoid'
import { createHash } from 'node:crypto'
import type { DbClient } from '@lucid/oracle-core'
import type { RedpandaProducer } from '@lucid/oracle-core'
import { TOPICS } from '@lucid/oracle-core'
import type { VerifierRegistry } from '@lucid/oracle-core'

interface RegisterResult {
  status: number
  error?: string
  data?: {
    agent_entity_id: string
    wallets: Array<{ chain: string; address: string }>
    evidence_id: number
    conflict_id?: number
  }
}

export class RegistrationHandler {
  constructor(
    private readonly db: DbClient,
    private readonly producer: RedpandaProducer,
    private readonly verifiers: VerifierRegistry,
  ) {}

  async register(nonce: string, signature: string): Promise<RegisterResult> {
    // 1. Lookup challenge
    const { rows: challenges } = await this.db.query(
      'SELECT * FROM registration_challenges WHERE nonce = $1',
      [nonce],
    )
    if (challenges.length === 0) {
      return { status: 404, error: 'Challenge not found' }
    }

    const challenge = challenges[0] as Record<string, any>

    // 2. Reject if expired or consumed
    if (challenge.consumed_at) {
      return { status: 410, error: 'Challenge already consumed' }
    }
    if (new Date(challenge.expires_at) < new Date()) {
      return { status: 410, error: 'Challenge expired' }
    }

    // 3. Verify signature using chain-appropriate verifier
    const verifier = this.verifiers.getForChain(challenge.chain as string)
    if (!verifier) {
      return { status: 400, error: `Unsupported chain: ${challenge.chain}` }
    }
    const valid = await verifier.verify(challenge.address as string, challenge.message as string, signature)
    if (!valid) {
      return { status: 401, error: 'Signature verification failed' }
    }

    // BEGIN TRANSACTION
    await this.db.query('BEGIN')

    try {
      let entityId: string

      if (challenge.target_entity) {
        // Re-validate auth mapping (race guard)
        const { rows: authRows } = await this.db.query(
          `SELECT agent_entity FROM wallet_mappings
           WHERE chain = $1 AND LOWER(address) = LOWER($2)
           AND agent_entity = $3 AND removed_at IS NULL`,
          [challenge.auth_chain, challenge.auth_address, challenge.target_entity],
        )
        if (authRows.length === 0) {
          await this.db.query('ROLLBACK')
          return { status: 403, error: 'Authorization expired — auth wallet no longer mapped to target entity' }
        }
        entityId = challenge.target_entity
      } else {
        // Find-or-create entity
        const { rows: existingMapping } = await this.db.query(
          `SELECT agent_entity FROM wallet_mappings
           WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
          [challenge.chain, challenge.address],
        )
        if (existingMapping.length > 0) {
          entityId = existingMapping[0].agent_entity as string
        } else {
          const newId = `ae_${nanoid()}`
          const { rows: entityRows } = await this.db.query(
            'INSERT INTO agent_entities (id, created_at, updated_at) VALUES ($1, now(), now()) RETURNING id',
            [newId],
          )
          entityId = entityRows[0].id as string
        }
      }

      // Store auth proof if attaching to existing entity
      if (challenge.target_entity && challenge.auth_chain && challenge.auth_address) {
        await this.db.query(
          `INSERT INTO identity_evidence
           (agent_entity, evidence_type, chain, address, message, metadata_json)
           VALUES ($1, 'signed_message', $2, $3, $4, $5)
           ON CONFLICT (agent_entity, evidence_type, chain, address)
           WHERE evidence_type = 'signed_message' AND revoked_at IS NULL
           DO NOTHING`,
          [
            entityId,
            challenge.auth_chain,
            challenge.auth_address,
            `[auth consent for ${challenge.chain}:${challenge.address}]`,
            JSON.stringify({
              verification_method: challenge.auth_chain === 'solana' ? 'ed25519' : 'personal_sign',
              purpose: 'entity_authorization',
              authorized_wallet: challenge.address,
              authorized_chain: challenge.chain,
            }),
          ],
        )
      }

      // Revoke previous signed_message evidence for this wallet+entity
      await this.db.query(
        `UPDATE identity_evidence SET revoked_at = now()
         WHERE agent_entity = $1 AND chain = $2 AND LOWER(address) = LOWER($3)
         AND evidence_type = 'signed_message' AND revoked_at IS NULL`,
        [entityId, challenge.chain, challenge.address],
      )

      // Insert new evidence
      const evidenceHash = createHash('sha256').update(challenge.message).digest('hex')
      const { rows: evidenceRows } = await this.db.query(
        `INSERT INTO identity_evidence
         (agent_entity, evidence_type, chain, address, signature, message, nonce, metadata_json)
         VALUES ($1, 'signed_message', $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          entityId,
          challenge.chain,
          challenge.address,
          signature,
          challenge.message,
          nonce,
          JSON.stringify({ verification_method: challenge.chain === 'solana' ? 'ed25519' : 'personal_sign' }),
        ],
      )
      const evidenceId = evidenceRows[0].id as number

      // Check existing mapping
      const { rows: existingWallet } = await this.db.query(
        `SELECT agent_entity, confidence FROM wallet_mappings
         WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
        [challenge.chain, challenge.address],
      )

      if (existingWallet.length > 0 && existingWallet[0].agent_entity !== entityId) {
        // Conflict
        const { rows: conflictRows } = await this.db.query(
          `INSERT INTO identity_conflicts
           (chain, address, existing_entity, claiming_entity, existing_confidence, claiming_confidence, claim_evidence_id)
           VALUES ($1, $2, $3, $4, $5, 1.0, $6)
           RETURNING id`,
          [
            challenge.chain,
            challenge.address,
            existingWallet[0].agent_entity,
            entityId,
            existingWallet[0].confidence,
            evidenceId,
          ],
        )

        await this.db.query(
          'UPDATE registration_challenges SET consumed_at = now() WHERE nonce = $1',
          [nonce],
        )

        await this.db.query('COMMIT')

        return {
          status: 409,
          error: 'Wallet claimed by another entity',
          data: {
            agent_entity_id: entityId,
            wallets: [],
            evidence_id: evidenceId,
            conflict_id: conflictRows[0].id as number,
          },
        }
      }

      // No conflict — upsert mapping
      if (existingWallet.length === 0) {
        await this.db.query(
          `INSERT INTO wallet_mappings
           (agent_entity, chain, address, link_type, confidence, evidence_hash)
           VALUES ($1, $2, $3, 'self_claim', 1.0, $4)`,
          [entityId, challenge.chain, challenge.address, evidenceHash],
        )
      }

      // Consume nonce
      await this.db.query(
        'UPDATE registration_challenges SET consumed_at = now() WHERE nonce = $1',
        [nonce],
      )

      // COMMIT
      await this.db.query('COMMIT')

      // Publish watchlist update (after commit)
      const chain = challenge.chain as string
      if (chain === 'solana' || chain === 'base') {
        await this.producer.publishJson(TOPICS.WATCHLIST, `watchlist:${chain}`, {
          action: 'add',
          chain,
          address: challenge.address,
          agent_entity_id: entityId,
        }).catch(() => {})
      }

      // Fetch wallets for response
      const { rows: wallets } = await this.db.query(
        `SELECT chain, address FROM wallet_mappings
         WHERE agent_entity = $1 AND removed_at IS NULL`,
        [entityId],
      )

      return {
        status: 200,
        data: {
          agent_entity_id: entityId,
          wallets: wallets.map((w) => ({ chain: w.chain as string, address: w.address as string })),
          evidence_id: evidenceId,
        },
      }
    } catch (err) {
      await this.db.query('ROLLBACK').catch(() => {})
      throw err
    }
  }
}
