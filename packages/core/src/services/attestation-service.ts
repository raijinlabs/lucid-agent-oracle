import { createHmac, createHash } from 'node:crypto'
import * as ed from '@noble/ed25519'
import { canonicalStringify } from '../utils/canonical-json.js'

// @noble/ed25519 v2 requires sha512Sync to be set in Node.js environments.
// Wire it up to Node's built-in crypto so all operations remain synchronous.
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash('sha512')
  for (const m of msgs) h.update(m)
  return new Uint8Array(h.digest())
}

/** Payload to be signed and published */
export interface ReportPayload {
  feed_id: string
  feed_version: number
  report_timestamp: number
  values: Record<string, unknown>
  input_manifest_hash: string
  computation_hash: string
  revision: number
}

/** Signed report envelope — multi-signer-ready */
export interface ReportEnvelope extends ReportPayload {
  signer_set_id: string
  signatures: Array<{ signer: string; sig: string }>
}

interface AttestationConfig {
  /** Hex-encoded 32-byte private key */
  privateKeyHex?: string
  /** Derive key deterministically from seed via HMAC-SHA512 */
  seed?: string
}

/**
 * Ed25519 attestation service for signing oracle reports.
 * Uses @noble/ed25519 v2+ (synchronous mode).
 */
export class AttestationService {
  private readonly privateKey: Uint8Array
  private readonly publicKeyHex: string

  constructor(config?: AttestationConfig) {
    if (config?.privateKeyHex) {
      this.privateKey = hexToBytes(config.privateKeyHex)
    } else if (config?.seed) {
      const derived = createHmac('sha512', 'lucid-oracle-economy')
        .update(config.seed)
        .digest()
      this.privateKey = new Uint8Array(derived.subarray(0, 32))
    } else {
      const envKey = process.env.ORACLE_ATTESTATION_KEY
      if (envKey) {
        this.privateKey = hexToBytes(envKey)
      } else {
        this.privateKey = ed.utils.randomPrivateKey()
      }
    }
    // @noble/ed25519 v2+ with sha512Sync is always synchronous.
    const pubBytes = ed.getPublicKey(this.privateKey)
    this.publicKeyHex = bytesToHex(pubBytes)
  }

  /** Sign a report payload and return the full envelope */
  signReport(payload: ReportPayload): ReportEnvelope {
    const message = this.canonicalize(payload)
    const msgBytes = new TextEncoder().encode(message)
    const sig = ed.sign(msgBytes, this.privateKey)

    return {
      ...payload,
      signer_set_id: 'ss_lucid_v1',
      signatures: [{
        signer: this.publicKeyHex,
        sig: bytesToHex(sig),
      }],
    }
  }

  /** Verify all signatures on a report envelope */
  verifyReport(envelope: ReportEnvelope): boolean {
    if (envelope.signatures.length === 0) return false
    const { signer_set_id, signatures, ...payload } = envelope
    const message = this.canonicalize(payload as ReportPayload)
    const msgBytes = new TextEncoder().encode(message)

    for (const { signer, sig } of signatures) {
      const valid = ed.verify(hexToBytes(sig), msgBytes, hexToBytes(signer))
      if (!valid) return false
    }
    return true
  }

  /** Get the hex-encoded public key */
  getPublicKey(): string {
    return this.publicKeyHex
  }

  private canonicalize(obj: unknown): string {
    return canonicalStringify(obj)
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
