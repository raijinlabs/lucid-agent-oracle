import { describe, it, expect } from 'vitest'
import { solanaVerifier } from '../identity/solana-verifier.js'

describe('SolanaVerifier', () => {
  it('has correct chain list', () => {
    expect(solanaVerifier.chains).toEqual(['solana'])
  })

  it('verifies a valid Ed25519 signature (base58 encoded)', async () => {
    const ed = await import('@noble/ed25519')
    const bs58 = (await import('bs58')).default
    // Generate keypair
    const privKey = ed.utils.randomPrivateKey()
    const pubKey = await ed.getPublicKeyAsync(privKey)
    const message = 'Lucid Agent Oracle — test message'
    const msgBytes = new TextEncoder().encode(message)
    const signature = await ed.signAsync(msgBytes, privKey)

    // Encode as base58 (Solana native format)
    const sigB58 = bs58.encode(signature)
    const pubB58 = bs58.encode(pubKey)

    const result = await solanaVerifier.verify(pubB58, message, sigB58)
    expect(result).toBe(true)
  })

  it('rejects a signature from a different key', async () => {
    const ed = await import('@noble/ed25519')
    const bs58 = (await import('bs58')).default
    const privKey = ed.utils.randomPrivateKey()
    const otherPriv = ed.utils.randomPrivateKey()
    const otherPub = await ed.getPublicKeyAsync(otherPriv)
    const message = 'test'
    const msgBytes = new TextEncoder().encode(message)
    const signature = await ed.signAsync(msgBytes, privKey)

    const sigB58 = bs58.encode(signature)
    const otherPubB58 = bs58.encode(otherPub)

    const result = await solanaVerifier.verify(otherPubB58, message, sigB58)
    expect(result).toBe(false)
  })

  it('returns false for malformed input', async () => {
    const result = await solanaVerifier.verify('bad-key', 'test', 'bad-sig')
    expect(result).toBe(false)
  })
})
