import { createHash } from 'node:crypto'
import * as ed from '@noble/ed25519'
import bs58 from 'bs58'
import type { WalletVerifier } from './wallet-verifier.js'

// Required for @noble/ed25519 v2 in Node.js — must run before any verify call.
// Same pattern as attestation-service.ts. Safe to call multiple times (idempotent).
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash('sha512')
  for (const m of msgs) h.update(m)
  return new Uint8Array(h.digest())
}

/**
 * Solana Ed25519 verifier — stateless, pure function.
 * Accepts base58-encoded addresses and signatures (Solana's native encoding).
 * No conversion needed at the route layer.
 */
export const solanaVerifier: WalletVerifier = {
  chains: ['solana'],

  async verify(address: string, message: string, signature: string): Promise<boolean> {
    try {
      const msgBytes = new TextEncoder().encode(message)
      const sigBytes = bs58.decode(signature)   // base58 -> Uint8Array (64 bytes)
      const pubBytes = bs58.decode(address)     // base58 -> Uint8Array (32 bytes)
      return await ed.verifyAsync(sigBytes, msgBytes, pubBytes)
    } catch {
      return false
    }
  },
}
