import { describe, it, expect, beforeEach } from 'vitest'
import {
  AttestationService,
  MultiSignerAttestationService,
  SignerSetRegistry,
  signerSetRegistry,
  type ReportPayload,
  type SignerSet,
} from '../services/attestation-service.js'

const PAYLOAD: ReportPayload = {
  feed_id: 'aegdp',
  feed_version: 1,
  report_timestamp: 1710547200000,
  values: { value_usd: 26251.50 },
  input_manifest_hash: 'abc123',
  computation_hash: 'def456',
  revision: 1,
}

// Generate 3 deterministic test keys
const KEY_1 = '0000000000000000000000000000000000000000000000000000000000000001'
const KEY_2 = '0000000000000000000000000000000000000000000000000000000000000002'
const KEY_3 = '0000000000000000000000000000000000000000000000000000000000000003'

describe('SignerSetRegistry', () => {
  let registry: SignerSetRegistry

  beforeEach(() => {
    registry = new SignerSetRegistry()
  })

  it('registers and retrieves a signer set', () => {
    const set: SignerSet = { id: 'ss_test', quorum: 2, signers: ['pub1', 'pub2', 'pub3'] }
    registry.register(set)
    expect(registry.get('ss_test')).toEqual(set)
    expect(registry.has('ss_test')).toBe(true)
  })

  it('returns undefined for unknown set', () => {
    expect(registry.get('nonexistent')).toBeUndefined()
    expect(registry.has('nonexistent')).toBe(false)
  })

  it('rejects quorum < 1', () => {
    expect(() => registry.register({ id: 'bad', quorum: 0, signers: ['pub1'] })).toThrow('Quorum must be >= 1')
  })

  it('rejects quorum > signer count', () => {
    expect(() => registry.register({ id: 'bad', quorum: 3, signers: ['pub1', 'pub2'] })).toThrow('exceeds signer count')
  })
})

describe('MultiSignerAttestationService', () => {
  it('produces N signatures for N keys', () => {
    const multi = new MultiSignerAttestationService({
      privateKeysHex: [KEY_1, KEY_2, KEY_3],
      signerSetId: 'ss_test_3',
    })

    const envelope = multi.signReport(PAYLOAD)

    expect(envelope.signer_set_id).toBe('ss_test_3')
    expect(envelope.signatures).toHaveLength(3)
    // Each signature has a different signer public key
    const signers = envelope.signatures.map((s) => s.signer)
    expect(new Set(signers).size).toBe(3)
  })

  it('produces valid signatures verifiable by single-signer service', () => {
    const multi = new MultiSignerAttestationService({
      privateKeysHex: [KEY_1],
      signerSetId: 'ss_single',
    })
    const single = new AttestationService({ privateKeyHex: KEY_1 })

    const envelope = multi.signReport(PAYLOAD)
    const valid = single.verifyReport(envelope)

    expect(valid).toBe(true)
  })

  it('getPublicKeys returns all public keys', () => {
    const multi = new MultiSignerAttestationService({
      privateKeysHex: [KEY_1, KEY_2],
      signerSetId: 'ss_test',
    })
    const keys = multi.getPublicKeys()
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    // Ed25519 public keys are 64 hex chars (32 bytes)
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/)
  })

  it('throws on empty key array', () => {
    expect(() => new MultiSignerAttestationService({
      privateKeysHex: [],
      signerSetId: 'ss_empty',
    })).toThrow('At least one private key')
  })

  it('signatures are deterministic', () => {
    const multi = new MultiSignerAttestationService({
      privateKeysHex: [KEY_1, KEY_2],
      signerSetId: 'ss_test',
    })

    const env1 = multi.signReport(PAYLOAD)
    const env2 = multi.signReport(PAYLOAD)

    expect(env1.signatures[0].sig).toBe(env2.signatures[0].sig)
    expect(env1.signatures[1].sig).toBe(env2.signatures[1].sig)
  })
})

describe('Quorum verification', () => {
  let multi: MultiSignerAttestationService

  beforeEach(() => {
    multi = new MultiSignerAttestationService({
      privateKeysHex: [KEY_1, KEY_2, KEY_3],
      signerSetId: 'ss_quorum_test',
    })

    const pubKeys = multi.getPublicKeys()
    signerSetRegistry.register({
      id: 'ss_quorum_test',
      quorum: 2,
      signers: pubKeys,
    })
  })

  it('valid: all 3 signatures meet quorum of 2', () => {
    const envelope = multi.signReport(PAYLOAD)
    const result = multi.verifyReport(envelope)
    expect(result.valid).toBe(true)
    expect(result.validCount).toBe(3)
    expect(result.quorum).toBe(2)
  })

  it('valid: 2 of 3 signatures meet quorum of 2', () => {
    const envelope = multi.signReport(PAYLOAD)
    // Remove one signature
    envelope.signatures = envelope.signatures.slice(0, 2)
    const result = multi.verifyReport(envelope)
    expect(result.valid).toBe(true)
    expect(result.validCount).toBe(2)
  })

  it('invalid: 1 of 3 signatures below quorum of 2', () => {
    const envelope = multi.signReport(PAYLOAD)
    envelope.signatures = envelope.signatures.slice(0, 1)
    const result = multi.verifyReport(envelope)
    expect(result.valid).toBe(false)
    expect(result.validCount).toBe(1)
  })

  it('invalid: tampered signature', () => {
    const envelope = multi.signReport(PAYLOAD)
    // Tamper with first signature
    envelope.signatures[0].sig = 'ff'.repeat(64)
    const result = multi.verifyReport(envelope)
    // Only 2 valid, still meets quorum
    expect(result.validCount).toBe(2)
    expect(result.valid).toBe(true)
  })

  it('invalid: all signatures tampered', () => {
    const envelope = multi.signReport(PAYLOAD)
    for (const sig of envelope.signatures) {
      sig.sig = 'ff'.repeat(64)
    }
    const result = multi.verifyReport(envelope)
    expect(result.valid).toBe(false)
    expect(result.validCount).toBe(0)
  })

  it('invalid: unknown signer set', () => {
    const envelope = multi.signReport(PAYLOAD)
    envelope.signer_set_id = 'ss_unknown'
    const result = multi.verifyReport(envelope)
    expect(result.valid).toBe(false)
  })

  it('rejects signatures from unauthorized signers', () => {
    // Create a rogue signer not in the set
    const rogue = new MultiSignerAttestationService({
      privateKeysHex: ['0000000000000000000000000000000000000000000000000000000000000099'],
      signerSetId: 'ss_quorum_test',
    })
    const rogueEnvelope = rogue.signReport(PAYLOAD)
    // Rogue signature is valid crypto but not authorized
    const result = multi.verifyReport(rogueEnvelope)
    expect(result.valid).toBe(false)
    expect(result.validCount).toBe(0)
  })

  it('backward compatible: single-signer envelope still works', () => {
    const single = new AttestationService({ privateKeyHex: KEY_1 })
    const envelope = single.signReport(PAYLOAD)

    // Register a set matching the single signer
    signerSetRegistry.register({
      id: 'ss_lucid_v1',
      quorum: 1,
      signers: [single.getPublicKey()],
    })

    const result = multi.verifyReport(envelope)
    expect(result.valid).toBe(true)
    expect(result.validCount).toBe(1)
  })
})

describe('fromEnv factory', () => {
  it('creates from ORACLE_ATTESTATION_KEY (single key fallback)', () => {
    process.env.ORACLE_ATTESTATION_KEY = KEY_1
    delete process.env.ORACLE_ATTESTATION_KEYS

    const service = MultiSignerAttestationService.fromEnv()
    expect(service.getPublicKeys()).toHaveLength(1)

    delete process.env.ORACLE_ATTESTATION_KEY
  })

  it('creates from ORACLE_ATTESTATION_KEYS (comma-separated)', () => {
    process.env.ORACLE_ATTESTATION_KEYS = `${KEY_1},${KEY_2},${KEY_3}`
    const service = MultiSignerAttestationService.fromEnv('ss_env_test')
    expect(service.getPublicKeys()).toHaveLength(3)

    delete process.env.ORACLE_ATTESTATION_KEYS
  })

  it('throws when no keys available', () => {
    delete process.env.ORACLE_ATTESTATION_KEY
    delete process.env.ORACLE_ATTESTATION_KEYS
    expect(() => MultiSignerAttestationService.fromEnv()).toThrow('must be set')
  })
})
