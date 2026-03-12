import { createHmac } from 'node:crypto'
import { computeEventId } from '../types/events.js'
import type { RawEconomicEvent } from '../types/events.js'

/** Known SPL token mints → human-readable symbols */
const KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'SOL',
}

/** Helius Enhanced Transaction format (simplified for our needs) */
export interface HeliusTransaction {
  signature: string
  type: string
  timestamp: number
  slot: number
  nativeTransfers: Array<{
    fromUserAccount: string
    toUserAccount: string
    amount: number
  }>
  tokenTransfers: Array<{
    fromUserAccount: string
    toUserAccount: string
    mint: string
    tokenAmount: number
    tokenStandard: string
  }>
  accountData: Array<Record<string, unknown>>
  description: string
}

/**
 * Normalize a Helius Enhanced Transaction into a RawEconomicEvent.
 * Returns null if the transaction does not involve the watched wallet.
 */
export function normalizeHeliusTransaction(
  tx: HeliusTransaction,
  watchedWallet: string,
): RawEconomicEvent | null {
  // Check native transfers
  for (const nt of tx.nativeTransfers) {
    if (nt.fromUserAccount === watchedWallet || nt.toUserAccount === watchedWallet) {
      return {
        event_id: computeEventId('agent_wallets_sol', 'solana', tx.signature, 0),
        source: 'agent_wallets_sol',
        source_adapter_ver: 1,
        ingestion_type: 'realtime',
        ingestion_ts: new Date(),
        chain: 'solana',
        block_number: tx.slot,
        tx_hash: tx.signature,
        log_index: 0,
        event_type: 'transfer',
        event_timestamp: new Date(tx.timestamp * 1000),
        subject_entity_id: null,
        subject_raw_id: nt.fromUserAccount === watchedWallet ? nt.fromUserAccount : nt.toUserAccount,
        subject_id_type: 'wallet',
        counterparty_raw_id: nt.fromUserAccount === watchedWallet ? nt.toUserAccount : nt.fromUserAccount,
        protocol: 'independent',
        amount: String(nt.amount),
        currency: 'SOL',
        usd_value: null,
        tool_name: null,
        model_id: null,
        provider: null,
        duration_ms: null,
        status: 'success',
        quality_score: 1.0,
        economic_authentic: true,
        corrects_event_id: null,
        correction_reason: null,
      }
    }
  }

  // Check token transfers
  for (let i = 0; i < tx.tokenTransfers.length; i++) {
    const tt = tx.tokenTransfers[i]
    if (tt.fromUserAccount === watchedWallet || tt.toUserAccount === watchedWallet) {
      return {
        event_id: computeEventId('agent_wallets_sol', 'solana', tx.signature, i + 1),
        source: 'agent_wallets_sol',
        source_adapter_ver: 1,
        ingestion_type: 'realtime',
        ingestion_ts: new Date(),
        chain: 'solana',
        block_number: tx.slot,
        tx_hash: tx.signature,
        log_index: i + 1,
        event_type: 'transfer',
        event_timestamp: new Date(tx.timestamp * 1000),
        subject_entity_id: null,
        subject_raw_id: tt.fromUserAccount === watchedWallet ? tt.fromUserAccount : tt.toUserAccount,
        subject_id_type: 'wallet',
        counterparty_raw_id: tt.fromUserAccount === watchedWallet ? tt.toUserAccount : tt.fromUserAccount,
        protocol: 'independent',
        amount: String(tt.tokenAmount),
        currency: KNOWN_MINTS[tt.mint] ?? tt.mint,
        usd_value: null,
        tool_name: null,
        model_id: null,
        provider: null,
        duration_ms: null,
        status: 'success',
        quality_score: 1.0,
        economic_authentic: true,
        corrects_event_id: null,
        correction_reason: null,
      }
    }
  }

  return null
}

/**
 * Verify Helius webhook HMAC-SHA256 signature.
 * Returns true if the signature matches the expected HMAC.
 */
export function verifyHeliusSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  return signature === expected
}
