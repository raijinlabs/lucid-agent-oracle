/** ERC-8004 identity event — published to raw.erc8004.events */
export interface ERC8004Event {
  /** Deterministic UUID from computeEventId() */
  event_id: string
  event_type: ERC8004EventType
  source: 'erc8004'
  chain: 'base'
  block_number: number
  tx_hash: string
  log_index: number
  timestamp: Date

  // Identity fields
  agent_id: string
  owner_address: string
  tba_address: string | null

  // Reputation fields (reputation_updated only)
  reputation_score: number | null
  validator_address: string | null
  evidence_hash: string | null

  // Raw event data
  raw_data: string
}

export type ERC8004EventType =
  | 'agent_registered'
  | 'agent_updated'
  | 'ownership_transferred'
  | 'reputation_updated'

/** Watchlist update event — published to wallet_watchlist.updated */
export interface WatchlistUpdate {
  action: 'add' | 'remove'
  chain: 'base' | 'solana'
  address: string
  agent_entity_id: string
}

/** Canonical agent entity — stored in Postgres agent_entities */
export interface AgentEntity {
  id: string
  display_name: string | null
  erc8004_id: string | null
  lucid_tenant: string | null
  reputation_json: Record<string, unknown> | null
  reputation_updated_at: Date | null
  created_at: Date
  updated_at: Date
}

/** Wallet → agent entity mapping — stored in Postgres wallet_mappings */
export interface WalletMapping {
  id: number
  agent_entity: string
  chain: string
  address: string
  link_type: WalletLinkType
  confidence: number
  evidence_hash: string | null
  created_at: Date
  removed_at: Date | null
}

export type WalletLinkType = 'erc8004_tba' | 'erc8004_owner' | 'lucid_passport' | 'self_claim'

/** Cross-protocol identity link — stored in Postgres identity_links */
export interface IdentityLink {
  id: number
  agent_entity: string
  protocol: string
  protocol_id: string
  link_type: string
  confidence: number
  evidence_json: string | null
  created_at: Date
}

/** Identity evidence — stored in Postgres identity_evidence */
export interface IdentityEvidence {
  id: number
  agent_entity: string
  evidence_type: 'signed_message' | 'on_chain_proof' | 'gateway_correlation'
  chain: string | null
  address: string | null
  signature: string | null
  message: string | null
  nonce: string | null
  verified_at: Date
  expires_at: Date | null
  revoked_at: Date | null
  metadata_json: Record<string, unknown> | null
}

/** Registration challenge — stored in Postgres registration_challenges */
export interface RegistrationChallenge {
  nonce: string
  chain: string
  address: string
  target_entity: string | null
  auth_chain: string | null
  auth_address: string | null
  message: string
  environment: string
  issued_at: Date
  expires_at: Date
  consumed_at: Date | null
}

/** Identity conflict — stored in Postgres identity_conflicts */
export interface IdentityConflict {
  id: number
  chain: string
  address: string
  existing_entity: string
  claiming_entity: string
  existing_confidence: number
  claiming_confidence: number
  claim_evidence_id: number | null
  status: 'open' | 'resolved' | 'dismissed'
  resolution: 'keep_existing' | 'keep_claiming' | 'merge' | null
  resolved_by: string | null
  resolution_reason: string | null
  resolved_at: Date | null
  created_at: Date
}
