import { createHash } from 'node:crypto'

/** Canonical raw economic event — the single source of truth.
 *  Maps 1:1 to the ClickHouse `raw_economic_events` table.
 *  Every economic signal in the system passes through this shape. */
export interface RawEconomicEvent {
  /** Deterministic UUID derived from natural key (source + chain + tx_hash + log_index) */
  event_id: string
  // ── Provenance ──
  /** Which data source produced this event */
  source: EventSource
  /** Adapter version that produced this event (for schema evolution) */
  source_adapter_ver: number
  /** How this event was ingested */
  ingestion_type: 'realtime' | 'backfill' | 'correction'
  /** When the oracle ingested this event */
  ingestion_ts: Date
  // ── Chain anchor ──
  /** Blockchain where the event occurred ('offchain' for gateway events) */
  chain: ChainId
  block_number: number | null
  tx_hash: string | null
  log_index: number | null
  // ── Economic signal ──
  event_type: EventType
  /** When the economic activity actually happened */
  event_timestamp: Date
  /** Resolved canonical entity ID (null until identity resolution runs) */
  subject_entity_id: string | null
  /** Raw identifier from the source system */
  subject_raw_id: string
  subject_id_type: SubjectIdType
  counterparty_raw_id: string | null
  protocol: ProtocolId
  /** Monetary amount in native units (string to avoid float precision) */
  amount: string | null
  currency: string | null
  /** USD-equivalent value (string for precision) */
  usd_value: string | null
  // ── Context metadata ──
  tool_name: string | null
  model_id: string | null
  provider: string | null
  duration_ms: number | null
  status: EventStatus
  // ── Quality ──
  /** Source-assigned quality score [0.0, 1.0] */
  quality_score: number
  /** Whether this event represents genuine economic activity (not spam/test) */
  economic_authentic: boolean
  // ── Correction chain ──
  /** If this event corrects a previous one, the corrected event's ID */
  corrects_event_id: string | null
  correction_reason: string | null
}

/** Data source identifiers — each maps to an adapter in the ingestion pipeline */
export type EventSource =
  | 'lucid_gateway'
  | 'virtuals_acp'
  | 'olas_gnosis'
  | 'olas_base'
  | 'olas_optimism'
  | 'erc8004'
  | 'agent_wallets_sol'
  | 'agent_wallets_evm'
  | 'cookie_api'

/** Supported blockchain identifiers */
export type ChainId =
  | 'solana'
  | 'base'
  | 'ethereum'
  | 'gnosis'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'offchain'

/** Categories of economic activity tracked by the oracle */
export type EventType =
  | 'payment'
  | 'llm_inference'
  | 'tool_call'
  | 'task_complete'
  | 'agent_register'
  | 'revenue_distribute'
  | 'swap'
  | 'stake'
  | 'identity_link'
  | 'reputation_update'
  | 'transfer'
  | 'contract_interaction'

/** How the subject was identified in the source system */
export type SubjectIdType =
  | 'wallet'
  | 'tenant'
  | 'erc8004'
  | 'protocol_native'

/** Protocol identifiers — each represents an indexed agent economy protocol */
export type ProtocolId =
  | 'lucid'
  | 'virtuals'
  | 'olas'
  | 'independent'

/** Outcome status of the economic activity */
export type EventStatus =
  | 'success'
  | 'error'
  | 'timeout'
  | 'denied'

/**
 * Compute a deterministic event ID from the event's natural key.
 * Uses SHA-256 truncated to UUID format for human readability.
 *
 * @param source - The data source identifier
 * @param chain - The blockchain identifier
 * @param txHash - Transaction hash (null for offchain events)
 * @param logIndex - Log index within the transaction (null for offchain)
 * @param fallbackKey - Fallback key for offchain events (e.g., 'receipt_abc123')
 * @returns Deterministic UUID-formatted string
 */
export function computeEventId(
  source: string,
  chain: string,
  txHash: string | null,
  logIndex: number | null,
  fallbackKey?: string,
): string {
  const input = `${source}:${chain}:${txHash ?? 'none'}:${logIndex ?? 'none'}:${fallbackKey ?? ''}`
  const hash = createHash('sha256').update(input).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}
