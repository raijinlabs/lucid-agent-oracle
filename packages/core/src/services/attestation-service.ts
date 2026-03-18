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

// ── Signer Set ───────────────────────────────────────────────

/** A named group of signers with a quorum threshold. */
export interface SignerSet {
  /** Unique identifier, e.g. 'ss_lucid_v1', 'ss_multi_v1' */
  id: string
  /** Required number of valid signatures for a report to be accepted */
  quorum: number
  /** Public keys (hex) of authorized signers */
  signers: string[]
}

/** Registry of known signer sets for verification. */
export class SignerSetRegistry {
  private sets = new Map<string, SignerSet>()

  register(set: SignerSet): void {
    if (set.quorum < 1) throw new Error(`Quorum must be >= 1, got ${set.quorum}`)
    if (set.quorum > set.signers.length) throw new Error(`Quorum ${set.quorum} exceeds signer count ${set.signers.length}`)
    this.sets.set(set.id, set)
  }

  get(id: string): SignerSet | undefined {
    return this.sets.get(id)
  }

  has(id: string): boolean {
    return this.sets.has(id)
  }
}

/** Global signer set registry. */
export const signerSetRegistry = new SignerSetRegistry()

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

// ── Multi-Signer Attestation ─────────────────────────────────

interface MultiSignerConfig {
  /** One or more hex-encoded 32-byte private keys */
  privateKeysHex: string[]
  /** Signer set ID for the envelope (registered in SignerSetRegistry) */
  signerSetId: string
}

/**
 * Multi-signer attestation service.
 * Signs reports with N keys and produces N signatures in the envelope.
 * Verifies against the signer set's quorum threshold.
 */
export class MultiSignerAttestationService {
  private readonly signers: AttestationService[]
  private readonly signerSetId: string

  constructor(config: MultiSignerConfig) {
    if (config.privateKeysHex.length === 0) {
      throw new Error('At least one private key is required')
    }
    this.signerSetId = config.signerSetId
    this.signers = config.privateKeysHex.map(
      (hex) => new AttestationService({ privateKeyHex: hex }),
    )
  }

  /** Sign a report with all configured signers. */
  signReport(payload: ReportPayload): ReportEnvelope {
    const message = canonicalStringify(payload)
    const msgBytes = new TextEncoder().encode(message)

    const signatures = this.signers.map((signer) => {
      const sig = ed.sign(msgBytes, (signer as any).privateKey)
      return {
        signer: signer.getPublicKey(),
        sig: bytesToHex(sig),
      }
    })

    return {
      ...payload,
      signer_set_id: this.signerSetId,
      signatures,
    }
  }

  /**
   * Verify a report envelope against the registered signer set.
   * Returns true if at least `quorum` signatures are valid AND from authorized signers.
   */
  verifyReport(envelope: ReportEnvelope): { valid: boolean; validCount: number; quorum: number } {
    const set = signerSetRegistry.get(envelope.signer_set_id)
    if (!set) {
      return { valid: false, validCount: 0, quorum: 0 }
    }

    const { signer_set_id, signatures, ...payload } = envelope
    const message = canonicalStringify(payload as ReportPayload)
    const msgBytes = new TextEncoder().encode(message)

    let validCount = 0
    for (const { signer, sig } of signatures) {
      // Must be an authorized signer
      if (!set.signers.includes(signer)) continue
      const isValid = ed.verify(hexToBytes(sig), msgBytes, hexToBytes(signer))
      if (isValid) validCount++
    }

    return {
      valid: validCount >= set.quorum,
      validCount,
      quorum: set.quorum,
    }
  }

  /** Get all public keys for this multi-signer instance. */
  getPublicKeys(): string[] {
    return this.signers.map((s) => s.getPublicKey())
  }

  /** Create from ORACLE_ATTESTATION_KEYS env var (comma-separated hex keys). */
  static fromEnv(signerSetId: string = 'ss_multi_v1'): MultiSignerAttestationService {
    const keysRaw = process.env.ORACLE_ATTESTATION_KEYS
    if (keysRaw) {
      const keys = keysRaw.split(',').map((k) => k.trim()).filter(Boolean)
      if (keys.length > 0) {
        return new MultiSignerAttestationService({ privateKeysHex: keys, signerSetId })
      }
    }
    // Fallback to single key
    const singleKey = process.env.ORACLE_ATTESTATION_KEY
    if (singleKey) {
      return new MultiSignerAttestationService({ privateKeysHex: [singleKey], signerSetId: 'ss_lucid_v1' })
    }
    throw new Error('ORACLE_ATTESTATION_KEYS or ORACLE_ATTESTATION_KEY must be set')
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
