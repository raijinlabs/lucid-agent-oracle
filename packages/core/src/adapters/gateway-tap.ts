import { computeEventId } from '../types/events.js'
import type { RawEconomicEvent } from '../types/events.js'

const ADAPTER_VERSION = 1

/** Transform a receipt_events row into a RawEconomicEvent */
export function transformReceiptEvent(receipt: {
  id: string
  tenant_id: string
  model: string
  endpoint: string
  tokens_in: number
  tokens_out: number
  model_passport_id: string | null
  compute_passport_id: string | null
  created_at: string
}): RawEconomicEvent {
  const [provider, ...modelParts] = receipt.model.split('/')
  const modelId = modelParts.join('/') || receipt.model

  return {
    event_id: computeEventId('lucid_gateway', 'offchain', null, null, `receipt_${receipt.id}`),
    source: 'lucid_gateway',
    source_adapter_ver: ADAPTER_VERSION,
    ingestion_type: 'realtime',
    ingestion_ts: new Date(),
    chain: 'offchain',
    block_number: null,
    tx_hash: null,
    log_index: null,
    event_type: 'llm_inference',
    event_timestamp: new Date(receipt.created_at),
    subject_entity_id: null,
    subject_raw_id: receipt.tenant_id,
    subject_id_type: 'tenant',
    counterparty_raw_id: null,
    protocol: 'lucid',
    amount: null,
    currency: null,
    usd_value: null,
    tool_name: null,
    model_id: modelId,
    provider: provider || null,
    duration_ms: null,
    status: 'success',
    quality_score: 1.0,
    economic_authentic: true,
    corrects_event_id: null,
    correction_reason: null,
  }
}

/** Transform an mcpgate_audit_log row into a RawEconomicEvent */
export function transformAuditLogEntry(entry: {
  id: string
  tenant_id: string
  server_id: string
  tool_name: string
  status: string
  duration_ms: number
  created_at: string
}): RawEconomicEvent {
  return {
    event_id: computeEventId('lucid_gateway', 'offchain', null, null, `audit_${entry.id}`),
    source: 'lucid_gateway',
    source_adapter_ver: ADAPTER_VERSION,
    ingestion_type: 'realtime',
    ingestion_ts: new Date(),
    chain: 'offchain',
    block_number: null,
    tx_hash: null,
    log_index: null,
    event_type: 'tool_call',
    event_timestamp: new Date(entry.created_at),
    subject_entity_id: null,
    subject_raw_id: entry.tenant_id,
    subject_id_type: 'tenant',
    counterparty_raw_id: null,
    protocol: 'lucid',
    amount: null,
    currency: null,
    usd_value: null,
    tool_name: entry.tool_name,
    model_id: null,
    provider: entry.server_id,
    duration_ms: entry.duration_ms,
    status: entry.status as RawEconomicEvent['status'],
    quality_score: 1.0,
    economic_authentic: entry.status === 'success',
    corrects_event_id: null,
    correction_reason: null,
  }
}

/** Transform a gateway_payment_sessions row into a RawEconomicEvent.
 *
 *  IMPORTANT: Payment sessions are treated as provisional economic events.
 *  `status === 'active'` maps to success, but this does NOT imply settlement
 *  finality. Spent proofs and settlement receipts (which provide true economic
 *  finality) are deferred to Plan 2. Until then, all payment events should be
 *  treated as `revision: 'preliminary'` in downstream quality envelopes.
 *  See: docs/plans/2026-03-12-agent-economy-oracle-plan1-data-control-plane.md */
export function transformPaymentSession(session: {
  id: string
  tenant_id: string
  token: string
  deposit_amount: string
  chain?: string
  tx_hash?: string
  status: string
  created_at: string
}): RawEconomicEvent {
  return {
    event_id: computeEventId('lucid_gateway', session.chain ?? 'offchain', session.tx_hash ?? null, null, `payment_${session.id}`),
    source: 'lucid_gateway',
    source_adapter_ver: ADAPTER_VERSION,
    ingestion_type: 'realtime',
    ingestion_ts: new Date(),
    chain: (session.chain ?? 'offchain') as RawEconomicEvent['chain'],
    block_number: null,
    tx_hash: session.tx_hash ?? null,
    log_index: null,
    event_type: 'payment',
    event_timestamp: new Date(session.created_at),
    subject_entity_id: null,
    subject_raw_id: session.tenant_id,
    subject_id_type: 'tenant',
    counterparty_raw_id: null,
    protocol: 'lucid',
    amount: session.deposit_amount,
    currency: session.token,
    usd_value: null,
    tool_name: null,
    model_id: null,
    provider: null,
    duration_ms: null,
    status: session.status === 'active' ? 'success' : 'error',
    quality_score: 1.0,
    economic_authentic: true,
    corrects_event_id: null,
    correction_reason: null,
  }
}
