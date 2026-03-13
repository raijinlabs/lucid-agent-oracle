# Plan 4B: Self-Registration + Identity Evidence + Conflict Review — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cryptographic wallet self-registration, first-class identity evidence, conflict review, and Lucid-native batch resolver to the Agent Economy Oracle.

**Architecture:** Two-step challenge-response (issue nonce → submit signature) with EVM personal_sign and Solana Ed25519 verification. All writes transactional. Conservative conflict handling — every cross-entity wallet claim goes to admin review. Lucid batch resolver populates entities from gateway_tenants.payment_config with advisory lock concurrency guard.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify, pg (node-postgres), ethers v6, @noble/ed25519, vitest, Postgres (Supabase)

**Spec:** `docs/specs/2026-03-12-agent-economy-oracle-plan4b-self-registration-design.md`

---

## File Structure

### New files (packages/core — pure, stateless, reusable)

| File | Responsibility |
|------|---------------|
| `packages/core/src/identity/wallet-verifier.ts` | `WalletVerifier` interface + `VerifierRegistry` class |
| `packages/core/src/identity/evm-verifier.ts` | EVM personal_sign verification via ethers v6 |
| `packages/core/src/identity/solana-verifier.ts` | Solana Ed25519 verification via @noble/ed25519 |
| `packages/core/src/identity/challenge.ts` | Challenge + auth message generation/formatting |
| `packages/core/src/__tests__/evm-verifier.test.ts` | 4 tests |
| `packages/core/src/__tests__/solana-verifier.test.ts` | 4 tests |
| `packages/core/src/__tests__/verifier-registry.test.ts` | 3 tests |
| `packages/core/src/__tests__/challenge.test.ts` | 3 tests |

### New files (apps/api — routes + services)

| File | Responsibility |
|------|---------------|
| `apps/api/src/services/registration-handler.ts` | Transactional registration orchestrator |
| `apps/api/src/services/lucid-resolver.ts` | Batch resolver for gateway_tenants → agent_entities |
| `apps/api/src/services/rate-limiter.ts` | In-memory sliding-window rate limiter |
| `apps/api/src/routes/identity-registration.ts` | POST /agents/challenge + POST /agents/register |
| `apps/api/src/routes/identity-admin.ts` | GET/PATCH /conflicts + POST /resolve-lucid |
| `apps/api/src/__tests__/registration.test.ts` | 8 tests |
| `apps/api/src/__tests__/lucid-resolver.test.ts` | 5 tests |
| `apps/api/src/__tests__/conflict-review.test.ts` | 4 tests |
| `apps/api/src/__tests__/registration-race.test.ts` | 4 tests |

### New files (migrations)

| File | Responsibility |
|------|---------------|
| `migrations/supabase/20260313_identity_4b.sql` | identity_evidence, registration_challenges, identity_conflicts, lucid_tenant unique index |

### Modified files

| File | Change |
|------|--------|
| `packages/core/src/types/identity.ts` | Add `'self_claim'` to `WalletLinkType`, add `IdentityEvidence`, `IdentityConflict`, `RegistrationChallenge` interfaces |
| `packages/core/src/index.ts` | Export all verifier + challenge modules |
| `packages/core/package.json` | Add `ethers` dependency |
| `apps/api/src/server.ts` | Wire registration routes, Lucid resolver at startup, challenge cleanup sweep |

---

## Chunk 1: Foundation — Types, Verifiers, Registry

### Task 1: Database Migration

**Files:**
- Create: `migrations/supabase/20260313_identity_4b.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Plan 4B: Self-Registration + Identity Evidence + Conflict Review
-- Depends on: 20260312_agent_identity.sql (Plan 4A tables)

-- 1. Add UNIQUE constraint on lucid_tenant (was indexed but not unique in 4A)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_entities_lucid_unique
  ON agent_entities(lucid_tenant) WHERE lucid_tenant IS NOT NULL;

-- 2. registration_challenges — nonce-based challenge-response
CREATE TABLE IF NOT EXISTS registration_challenges (
  nonce           TEXT PRIMARY KEY,
  chain           TEXT NOT NULL,
  address         TEXT NOT NULL,
  target_entity   TEXT,
  auth_chain      TEXT,
  auth_address    TEXT,
  message         TEXT NOT NULL,
  environment     TEXT NOT NULL,
  issued_at       TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_challenges_lookup
  ON registration_challenges(chain, address) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_challenges_expiry
  ON registration_challenges(expires_at) WHERE consumed_at IS NULL;

-- 3. identity_evidence — first-class evidence table (replaces inline evidence_json)
CREATE TABLE IF NOT EXISTS identity_evidence (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity    TEXT NOT NULL REFERENCES agent_entities(id),
  evidence_type   TEXT NOT NULL,
  chain           TEXT,
  address         TEXT,
  signature       TEXT,
  message         TEXT,
  nonce           TEXT,
  verified_at     TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  metadata_json   JSONB
);

CREATE INDEX IF NOT EXISTS idx_evidence_entity ON identity_evidence(agent_entity);
CREATE INDEX IF NOT EXISTS idx_evidence_chain_address ON identity_evidence(chain, address);

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_dedup_correlation
  ON identity_evidence(agent_entity, evidence_type, chain, address)
  WHERE evidence_type = 'gateway_correlation' AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_dedup_signed
  ON identity_evidence(agent_entity, evidence_type, chain, address)
  WHERE evidence_type = 'signed_message' AND revoked_at IS NULL;

-- 4. identity_conflicts — conservative conflict handling
CREATE TABLE IF NOT EXISTS identity_conflicts (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain               TEXT NOT NULL,
  address             TEXT NOT NULL,
  existing_entity     TEXT NOT NULL REFERENCES agent_entities(id),
  claiming_entity     TEXT NOT NULL REFERENCES agent_entities(id),
  existing_confidence REAL NOT NULL,
  claiming_confidence REAL NOT NULL,
  claim_evidence_id   BIGINT REFERENCES identity_evidence(id),
  status              TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution          TEXT
                      CHECK (resolution IS NULL OR resolution IN ('keep_existing', 'keep_claiming', 'merge')),
  resolved_by         TEXT,
  resolution_reason   TEXT,
  resolved_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conflicts_status ON identity_conflicts(status) WHERE status = 'open';
```

- [ ] **Step 2: Verify migration syntax**

Run: `cd /c/lucid-agent-oracle && cat migrations/supabase/20260313_identity_4b.sql | head -5`
Expected: First lines of the migration visible

- [ ] **Step 3: Commit**

```bash
git add migrations/supabase/20260313_identity_4b.sql
git commit -m "feat(4b): add identity_evidence, registration_challenges, identity_conflicts tables"
```

---

### Task 2: Extend Identity Types

**Files:**
- Modify: `packages/core/src/types/identity.ts`

- [ ] **Step 1: Add 'self_claim' to WalletLinkType and new interfaces**

Add to end of `identity.ts`:

```typescript
// After existing WalletLinkType (line 66):
// CHANGE: export type WalletLinkType = 'erc8004_tba' | 'erc8004_owner' | 'lucid_passport'
// TO:     export type WalletLinkType = 'erc8004_tba' | 'erc8004_owner' | 'lucid_passport' | 'self_claim'

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
```

- [ ] **Step 2: Run type check**

Run: `cd /c/lucid-agent-oracle && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/identity.ts
git commit -m "feat(4b): extend WalletLinkType with self_claim, add evidence/challenge/conflict types"
```

---

### Task 3: WalletVerifier Interface + VerifierRegistry

**Files:**
- Create: `packages/core/src/identity/wallet-verifier.ts`
- Test: `packages/core/src/__tests__/verifier-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/verifier-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { VerifierRegistry } from '../identity/wallet-verifier.js'
import type { WalletVerifier } from '../identity/wallet-verifier.js'

describe('VerifierRegistry', () => {
  let registry: VerifierRegistry

  beforeEach(() => {
    registry = new VerifierRegistry()
  })

  it('registers a verifier and looks it up by chain', () => {
    const mock: WalletVerifier = {
      chains: ['base', 'ethereum'],
      verify: async () => true,
    }
    registry.register(mock)
    expect(registry.getForChain('base')).toBe(mock)
    expect(registry.getForChain('ethereum')).toBe(mock)
    expect(registry.getForChain('solana')).toBeUndefined()
  })

  it('throws on duplicate chain registration', () => {
    const a: WalletVerifier = { chains: ['base'], verify: async () => true }
    const b: WalletVerifier = { chains: ['base'], verify: async () => true }
    registry.register(a)
    expect(() => registry.register(b)).toThrow('already registered')
  })

  it('lists all supported chains', () => {
    const evm: WalletVerifier = { chains: ['base', 'ethereum'], verify: async () => true }
    const sol: WalletVerifier = { chains: ['solana'], verify: async () => true }
    registry.register(evm)
    registry.register(sol)
    expect(registry.supportedChains()).toEqual(['base', 'ethereum', 'solana'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/verifier-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/identity/wallet-verifier.ts

/** Stateless signature verifier — one per chain family */
export interface WalletVerifier {
  readonly chains: readonly string[]
  verify(address: string, message: string, signature: string): Promise<boolean>
}

/** Maps chain → verifier at startup */
export class VerifierRegistry {
  private readonly byChain = new Map<string, WalletVerifier>()

  register(verifier: WalletVerifier): void {
    for (const chain of verifier.chains) {
      if (this.byChain.has(chain)) {
        throw new Error(`Chain "${chain}" already registered`)
      }
      this.byChain.set(chain, verifier)
    }
  }

  getForChain(chain: string): WalletVerifier | undefined {
    return this.byChain.get(chain)
  }

  getForChainOrThrow(chain: string): WalletVerifier {
    const v = this.byChain.get(chain)
    if (!v) throw new Error(`No verifier registered for chain "${chain}"`)
    return v
  }

  supportedChains(): string[] {
    return [...this.byChain.keys()]
  }
}

/** Singleton registry — populated at startup */
export const verifierRegistry = new VerifierRegistry()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/verifier-registry.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity/wallet-verifier.ts packages/core/src/__tests__/verifier-registry.test.ts
git commit -m "feat(4b): WalletVerifier interface + VerifierRegistry"
```

---

### Task 4: EVM Verifier

**Files:**
- Create: `packages/core/src/identity/evm-verifier.ts`
- Test: `packages/core/src/__tests__/evm-verifier.test.ts`
- Modify: `packages/core/package.json` (add ethers)

- [ ] **Step 1: Install ethers**

Run: `cd /c/lucid-agent-oracle && npm install ethers bs58 --workspace=packages/core`

- [ ] **Step 2: Write the failing test**

```typescript
// packages/core/src/__tests__/evm-verifier.test.ts
import { describe, it, expect } from 'vitest'
import { evmVerifier } from '../identity/evm-verifier.js'

describe('EvmVerifier', () => {
  it('has correct chain list', () => {
    expect(evmVerifier.chains).toEqual(['base', 'ethereum', 'arbitrum', 'polygon', 'gnosis', 'optimism'])
  })

  it('verifies a valid personal_sign signature', async () => {
    // Generate a real signature using ethers
    const { ethers } = await import('ethers')
    const wallet = ethers.Wallet.createRandom()
    const message = 'Lucid Agent Oracle — test message'
    const signature = await wallet.signMessage(message)

    const result = await evmVerifier.verify(wallet.address, message, signature)
    expect(result).toBe(true)
  })

  it('rejects a signature from a different address', async () => {
    const { ethers } = await import('ethers')
    const wallet = ethers.Wallet.createRandom()
    const message = 'Lucid Agent Oracle — test message'
    const signature = await wallet.signMessage(message)

    // Different address
    const otherWallet = ethers.Wallet.createRandom()
    const result = await evmVerifier.verify(otherWallet.address, message, signature)
    expect(result).toBe(false)
  })

  it('returns false for malformed signature', async () => {
    const result = await evmVerifier.verify('0x1234', 'test', 'not-a-sig')
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/evm-verifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the implementation**

```typescript
// packages/core/src/identity/evm-verifier.ts
import { ethers } from 'ethers'
import type { WalletVerifier } from './wallet-verifier.js'

const EVM_CHAINS = ['base', 'ethereum', 'arbitrum', 'polygon', 'gnosis', 'optimism'] as const

/** EVM personal_sign (EIP-191) verifier — stateless, pure function */
export const evmVerifier: WalletVerifier = {
  chains: EVM_CHAINS,

  async verify(address: string, message: string, signature: string): Promise<boolean> {
    try {
      const recovered = ethers.verifyMessage(message, signature)
      return recovered.toLowerCase() === address.toLowerCase()
    } catch {
      return false
    }
  },
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/evm-verifier.test.ts`
Expected: 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/identity/evm-verifier.ts packages/core/src/__tests__/evm-verifier.test.ts packages/core/package.json
git commit -m "feat(4b): EVM personal_sign verifier"
```

---

### Task 5: Solana Verifier

**Files:**
- Create: `packages/core/src/identity/solana-verifier.ts`
- Test: `packages/core/src/__tests__/solana-verifier.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/solana-verifier.test.ts
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
```

**Note:** The Solana verifier accepts base58-encoded addresses and signatures — Solana's native encoding. No conversion needed at the route layer. `bs58` is already a transitive dependency.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/solana-verifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/identity/solana-verifier.ts
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
      const sigBytes = bs58.decode(signature)   // base58 → Uint8Array (64 bytes)
      const pubBytes = bs58.decode(address)     // base58 → Uint8Array (32 bytes)
      return await ed.verifyAsync(sigBytes, msgBytes, pubBytes)
    } catch {
      return false
    }
  },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/solana-verifier.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity/solana-verifier.ts packages/core/src/__tests__/solana-verifier.test.ts
git commit -m "feat(4b): Solana Ed25519 verifier"
```

---

### Task 6: Challenge Message Generator

**Files:**
- Create: `packages/core/src/identity/challenge.ts`
- Test: `packages/core/src/__tests__/challenge.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/challenge.test.ts
import { describe, it, expect } from 'vitest'
import { formatChallengeMessage, formatAuthMessage } from '../identity/challenge.js'

describe('formatChallengeMessage', () => {
  it('formats a new-entity challenge message', () => {
    const msg = formatChallengeMessage({
      agentEntity: 'new',
      address: '0xABC123',
      chain: 'base',
      environment: 'production',
      nonce: 'test-nonce-uuid',
      issuedAt: '2026-03-12T10:00:00Z',
      expiresAt: '2026-03-12T10:05:00Z',
    })

    expect(msg).toContain('Lucid Agent Oracle — Wallet Verification')
    expect(msg).toContain('Agent: new')
    expect(msg).toContain('Wallet: 0xABC123')
    expect(msg).toContain('Chain: base')
    expect(msg).toContain('Environment: production')
    expect(msg).toContain('Domain: oracle.lucid.foundation')
    expect(msg).toContain('Nonce: test-nonce-uuid')
  })

  it('formats an existing-entity challenge message', () => {
    const msg = formatChallengeMessage({
      agentEntity: 'ae_existing123',
      address: '0xDEF456',
      chain: 'ethereum',
      environment: 'staging',
      nonce: 'uuid-2',
      issuedAt: '2026-03-12T10:00:00Z',
      expiresAt: '2026-03-12T10:05:00Z',
    })
    expect(msg).toContain('Agent: ae_existing123')
  })
})

describe('formatAuthMessage', () => {
  it('formats an entity authorization message', () => {
    const msg = formatAuthMessage({
      targetEntity: 'ae_target',
      newAddress: '0xNEW',
      newChain: 'base',
      authAddress: '0xAUTH',
      authChain: 'ethereum',
      environment: 'production',
      timestamp: '2026-03-12T10:00:00Z',
    })

    expect(msg).toContain('Lucid Agent Oracle — Entity Authorization')
    expect(msg).toContain('Entity: ae_target')
    expect(msg).toContain('New Wallet: 0xNEW')
    expect(msg).toContain('Auth Wallet: 0xAUTH')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/challenge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// packages/core/src/identity/challenge.ts

export interface ChallengeMessageParams {
  agentEntity: string  // entity ID or 'new'
  address: string
  chain: string
  environment: string
  nonce: string
  issuedAt: string     // ISO 8601 UTC
  expiresAt: string    // ISO 8601 UTC
}

export interface AuthMessageParams {
  targetEntity: string
  newAddress: string
  newChain: string
  authAddress: string
  authChain: string
  environment: string
  timestamp: string    // ISO 8601 UTC
}

/** Format the challenge message the NEW wallet signs */
export function formatChallengeMessage(params: ChallengeMessageParams): string {
  return `Lucid Agent Oracle — Wallet Verification

Action: Link wallet to agent identity
Agent: ${params.agentEntity}
Wallet: ${params.address}
Chain: ${params.chain}
Environment: ${params.environment}
Domain: oracle.lucid.foundation
Nonce: ${params.nonce}
Issued: ${params.issuedAt}
Expires: ${params.expiresAt}`
}

/** Format the auth message the EXISTING wallet signs to authorize attachment */
export function formatAuthMessage(params: AuthMessageParams): string {
  return `Lucid Agent Oracle — Entity Authorization

Action: Authorize wallet attachment
Entity: ${params.targetEntity}
New Wallet: ${params.newAddress}
New Chain: ${params.newChain}
Auth Wallet: ${params.authAddress}
Auth Chain: ${params.authChain}
Environment: ${params.environment}
Timestamp: ${params.timestamp}`
}

/** Challenge validity window in milliseconds (5 minutes) */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** Auth signature max age in milliseconds (5 minutes) */
export const AUTH_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run packages/core/src/__tests__/challenge.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity/challenge.ts packages/core/src/__tests__/challenge.test.ts
git commit -m "feat(4b): challenge + auth message formatters"
```

---

### Task 7: Core Exports + Verifier Registration

**Files:**
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add identity/verifier exports**

Add after the existing adapter framework exports block:

```typescript
// Identity verification (Plan 4B)
export type { WalletVerifier } from './identity/wallet-verifier.js'
export { VerifierRegistry, verifierRegistry } from './identity/wallet-verifier.js'
export { evmVerifier } from './identity/evm-verifier.js'
export { solanaVerifier } from './identity/solana-verifier.js'
export {
  formatChallengeMessage,
  formatAuthMessage,
  CHALLENGE_TTL_MS,
  AUTH_SIGNATURE_MAX_AGE_MS,
  type ChallengeMessageParams,
  type AuthMessageParams,
} from './identity/challenge.js'
```

- [ ] **Step 2: Run type check**

Run: `cd /c/lucid-agent-oracle && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run all existing tests to verify no regressions**

Run: `cd /c/lucid-agent-oracle && npx vitest run`
Expected: All existing tests pass + new tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(4b): export verifier framework + challenge utilities from @lucid/oracle-core"
```

---

## Chunk 2: Registration Service + Routes

### Task 8: Rate Limiter Utility

**Files:**
- Create: `apps/api/src/services/rate-limiter.ts`

- [ ] **Step 1: Write the rate limiter**

```typescript
// apps/api/src/services/rate-limiter.ts

interface RateLimitEntry {
  timestamps: number[]
}

/** In-memory sliding-window rate limiter. No Redis dependency. */
export class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>()
  private readonly windowMs: number
  private readonly maxRequests: number

  constructor(windowMs: number, maxRequests: number) {
    this.windowMs = windowMs
    this.maxRequests = maxRequests
  }

  /** Returns true if the request is allowed, false if rate limited */
  check(key: string): boolean {
    const now = Date.now()
    const cutoff = now - this.windowMs

    let entry = this.store.get(key)
    if (!entry) {
      entry = { timestamps: [] }
      this.store.set(key, entry)
    }

    // Prune old timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff)

    if (entry.timestamps.length >= this.maxRequests) {
      return false
    }

    entry.timestamps.push(now)
    return true
  }

  /** Milliseconds until the next request would be allowed */
  retryAfterMs(key: string): number {
    const entry = this.store.get(key)
    if (!entry || entry.timestamps.length === 0) return 0
    const oldest = entry.timestamps[0]
    return Math.max(0, oldest + this.windowMs - Date.now())
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/services/rate-limiter.ts
git commit -m "feat(4b): in-memory sliding-window rate limiter"
```

---

### Task 9: Registration Handler Service

**Files:**
- Create: `apps/api/src/services/registration-handler.ts`
- Test: `apps/api/src/__tests__/registration.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/__tests__/registration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RegistrationHandler } from '../services/registration-handler.js'
import { VerifierRegistry } from '@lucid/oracle-core'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

/** Creates a mock VerifierRegistry where all chains verify successfully */
function mockVerifiers(result = true) {
  const reg = new VerifierRegistry()
  reg.register({ chains: ['base', 'ethereum'], verify: async () => result })
  reg.register({ chains: ['solana'], verify: async () => result })
  return reg
}

describe('RegistrationHandler', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>
  let handler: RegistrationHandler

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    handler = new RegistrationHandler(db, producer, mockVerifiers())
    vi.clearAllMocks()
  })

  it('rejects expired challenge', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test', environment: 'production',
        expires_at: new Date(Date.now() - 60_000), // expired
        consumed_at: null,
      }],
    })

    const result = await handler.register('n1', '0xsig')
    expect(result.error).toContain('expired')
    expect(result.status).toBe(410)
  })

  it('rejects consumed challenge', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: new Date(), // already consumed
      }],
    })

    const result = await handler.register('n1', '0xsig')
    expect(result.error).toContain('consumed')
    expect(result.status).toBe(410)
  })

  it('rejects missing challenge', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })
    const result = await handler.register('missing', '0xsig')
    expect(result.status).toBe(404)
  })

  it('creates new entity + mapping + evidence on success (new entity flow)', async () => {
    // 1. Challenge lookup
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Check existing entity by wallet — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Create entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_new123' }] })
    // 5. Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] })
    // 7. Check existing mapping — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 8. Insert mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. Fetch wallets for response
    db.query.mockResolvedValueOnce({ rows: [{ chain: 'base', address: '0xABC' }] })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(200)
    expect(result.data?.agent_entity_id).toBe('ae_new123')
  })

  it('detects conflict when wallet mapped to different entity', async () => {
    // 1. Challenge lookup
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Check existing entity by wallet — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Create entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_claiming' }] })
    // 5. Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] })
    // 7. Check existing mapping — mapped to different entity!
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_existing', confidence: 0.8 }],
    })
    // 8. Insert conflict
    db.query.mockResolvedValueOnce({ rows: [{ id: 42 }] })
    // 9. Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT (entity + evidence + conflict persisted, no mapping)
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(409)
    expect(result.data?.conflict_id).toBe(42)
  })

  it('rejects target_entity registration when auth mapping revoked (race guard)', async () => {
    // 1. Challenge lookup — has target_entity + auth
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xNEW',
        target_entity: 'ae_target', auth_chain: 'base', auth_address: '0xAUTH',
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Re-validate auth mapping — REVOKED (empty result)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. ROLLBACK
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(403)
    expect(result.error).toContain('Authorization expired')
  })

  it('rejects invalid signature', async () => {
    // Create handler with a verifier that always rejects
    const rejectHandler = new RegistrationHandler(db, producer, mockVerifiers(false))

    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xABC',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })

    const result = await rejectHandler.register('n1', '0xsig')
    expect(result.status).toBe(401)
  })

  it('attaches wallet to existing entity when target_entity set', async () => {
    // 1. Challenge lookup — target_entity set
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'n1', chain: 'base', address: '0xNEW',
        target_entity: 'ae_target', auth_chain: 'base', auth_address: '0xAUTH',
        message: 'test-msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Re-validate auth mapping — still active
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_target' }],
    })
    // 4. Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 5 }] })
    // 6. Check existing mapping — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // 7. Insert mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 8. Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. Fetch wallets for response
    db.query.mockResolvedValueOnce({
      rows: [
        { chain: 'base', address: '0xAUTH' },
        { chain: 'base', address: '0xNEW' },
      ],
    })

    const result = await handler.register('n1', '0xsig')
    expect(result.status).toBe(200)
    expect(result.data?.agent_entity_id).toBe('ae_target')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/registration.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/services/registration-handler.ts
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
        // 5. Re-validate auth mapping (race guard)
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
        // 4. Find-or-create entity
        // Check if this wallet already maps to an entity
        const { rows: existingMapping } = await this.db.query(
          `SELECT agent_entity FROM wallet_mappings
           WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
          [challenge.chain, challenge.address],
        )
        if (existingMapping.length > 0) {
          entityId = existingMapping[0].agent_entity as string
        } else {
          entityId = `ae_${nanoid()}`
          await this.db.query(
            'INSERT INTO agent_entities (id, created_at, updated_at) VALUES ($1, now(), now())',
            [entityId],
          )
        }
      }

      // 5b. Store auth proof if attaching to existing entity (audit trail)
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

      // 6. Revoke previous signed_message evidence for this wallet+entity
      await this.db.query(
        `UPDATE identity_evidence SET revoked_at = now()
         WHERE agent_entity = $1 AND chain = $2 AND LOWER(address) = LOWER($3)
         AND evidence_type = 'signed_message' AND revoked_at IS NULL`,
        [entityId, challenge.chain, challenge.address],
      )

      // 6b. Insert new evidence
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

      // 7. Check existing mapping
      const { rows: existingWallet } = await this.db.query(
        `SELECT agent_entity, confidence FROM wallet_mappings
         WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
        [challenge.chain, challenge.address],
      )

      if (existingWallet.length > 0 && existingWallet[0].agent_entity !== entityId) {
        // Conflict — different entity owns this wallet.
        // Insert conflict row, then COMMIT (entity + evidence + conflict are valid state).
        // The mapping is NOT created — that's the correct behavior.
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

        // Consume nonce even on conflict (prevents retry abuse)
        await this.db.query(
          'UPDATE registration_challenges SET consumed_at = now() WHERE nonce = $1',
          [nonce],
        )

        // COMMIT — entity, evidence, and conflict row are all persisted
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
      // If same entity, mapping already exists — evidence updated above

      // 8. Consume nonce
      await this.db.query(
        'UPDATE registration_challenges SET consumed_at = now() WHERE nonce = $1',
        [nonce],
      )

      // COMMIT
      await this.db.query('COMMIT')

      // 9. Publish watchlist update (after commit)
      const chain = challenge.chain as string
      if (chain === 'solana' || chain === 'base') {
        await this.producer.publishJson(TOPICS.WATCHLIST, `watchlist:${chain}`, {
          action: 'add',
          chain,
          address: challenge.address,
          agent_entity_id: entityId,
        }).catch(() => {}) // non-fatal
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/registration.test.ts`
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/registration-handler.ts apps/api/src/__tests__/registration.test.ts
git commit -m "feat(4b): transactional registration handler with conflict detection"
```

---

### Task 10: Registration Route Handlers

**Files:**
- Create: `apps/api/src/routes/identity-registration.ts`

- [ ] **Step 1: Write the route handler**

```typescript
// apps/api/src/routes/identity-registration.ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import {
  verifierRegistry,
  formatChallengeMessage,
  formatAuthMessage,
  CHALLENGE_TTL_MS,
  AUTH_SIGNATURE_MAX_AGE_MS,
} from '@lucid/oracle-core'
import type { DbClient, RedpandaProducer } from '@lucid/oracle-core'
import { RegistrationHandler } from '../services/registration-handler.js'
import { RateLimiter } from '../services/rate-limiter.js'

// NOTE: verifierRegistry is the singleton from @lucid/oracle-core,
// populated at startup in server.ts with evmVerifier + solanaVerifier.

const challengeRateByAddr = new RateLimiter(60_000, 10)
const challengeRateByIP = new RateLimiter(60_000, 30)
const registerRateByAddr = new RateLimiter(60_000, 5)
const registerRateByIP = new RateLimiter(60_000, 15)

export function registerIdentityRoutes(
  app: FastifyInstance,
  db: DbClient,
  producer: RedpandaProducer,
): void {
  const handler = new RegistrationHandler(db, producer, verifierRegistry)

  const environment = process.env.NODE_ENV === 'production' ? 'production' : 'staging'

  // POST /v1/oracle/agents/challenge
  app.post('/v1/oracle/agents/challenge', async (request, reply) => {
    const body = request.body as Record<string, string | undefined>
    const { chain, address, target_entity, auth_chain, auth_address, auth_signature } = body

    if (!chain || !address) {
      return reply.status(400).send({ error: 'chain and address are required' })
    }

    // Rate limit
    const addrKey = `${chain}:${address}`
    const ip = request.ip
    if (!challengeRateByAddr.check(addrKey)) {
      return reply.status(429).send({
        error: 'Rate limit exceeded',
        retry_after_ms: challengeRateByAddr.retryAfterMs(addrKey),
      })
    }
    if (!challengeRateByIP.check(ip)) {
      return reply.status(429).send({
        error: 'Rate limit exceeded',
        retry_after_ms: challengeRateByIP.retryAfterMs(ip),
      })
    }

    // Verify chain is supported
    const verifier = verifierRegistry.getForChain(chain)
    if (!verifier) {
      return reply.status(400).send({ error: `Unsupported chain: ${chain}` })
    }

    // If target_entity is set, require auth proof
    if (target_entity) {
      if (!auth_chain || !auth_address || !auth_signature) {
        return reply.status(400).send({ error: 'auth_chain, auth_address, and auth_signature required when target_entity is set' })
      }

      // Validate auth_timestamp from client (prevents indefinite replay)
      const auth_timestamp = body.auth_timestamp
      if (!auth_timestamp) {
        return reply.status(400).send({ error: 'auth_timestamp required when target_entity is set' })
      }
      const authTime = new Date(auth_timestamp)
      if (isNaN(authTime.getTime()) || Date.now() - authTime.getTime() > AUTH_SIGNATURE_MAX_AGE_MS) {
        return reply.status(400).send({ error: 'auth_timestamp expired or invalid (max 5 minutes)' })
      }

      // Verify auth_signature cryptographically
      const authVerifier = verifierRegistry.getForChain(auth_chain)
      if (!authVerifier) {
        return reply.status(400).send({ error: `Unsupported auth_chain: ${auth_chain}` })
      }

      const authMsg = formatAuthMessage({
        targetEntity: target_entity,
        newAddress: address,
        newChain: chain,
        authAddress: auth_address,
        authChain: auth_chain,
        environment,
        timestamp: auth_timestamp,
      })

      const authValid = await authVerifier.verify(auth_address, authMsg, auth_signature)
      if (!authValid) {
        return reply.status(401).send({ error: 'Auth signature verification failed' })
      }

      // Verify auth wallet is mapped to target entity
      const { rows } = await db.query(
        `SELECT id FROM wallet_mappings
         WHERE chain = $1 AND LOWER(address) = LOWER($2)
         AND agent_entity = $3 AND removed_at IS NULL`,
        [auth_chain, auth_address, target_entity],
      )
      if (rows.length === 0) {
        return reply.status(403).send({ error: 'Auth address not mapped to target entity' })
      }
    }

    // Generate challenge
    const nonce = randomUUID()
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS)

    const message = formatChallengeMessage({
      agentEntity: target_entity ?? 'new',
      address,
      chain,
      environment,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    })

    // Store challenge
    await db.query(
      `INSERT INTO registration_challenges
       (nonce, chain, address, target_entity, auth_chain, auth_address, message, environment, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [nonce, chain, address, target_entity ?? null, auth_chain ?? null, auth_address ?? null, message, environment, expiresAt],
    )

    return reply.send({ nonce, message, expires_at: expiresAt.toISOString() })
  })

  // POST /v1/oracle/agents/register
  app.post('/v1/oracle/agents/register', async (request, reply) => {
    const body = request.body as Record<string, string | undefined>
    const { nonce, signature } = body

    if (!nonce || !signature) {
      return reply.status(400).send({ error: 'nonce and signature are required' })
    }

    // Look up challenge to get address for rate limiting
    const { rows: challenges } = await db.query(
      'SELECT chain, address FROM registration_challenges WHERE nonce = $1',
      [nonce],
    )
    if (challenges.length > 0) {
      const c = challenges[0] as Record<string, string>
      const addrKey = `${c.chain}:${c.address}`
      const ip = request.ip
      if (!registerRateByAddr.check(addrKey)) {
        return reply.status(429).send({
          error: 'Rate limit exceeded',
          retry_after_ms: registerRateByAddr.retryAfterMs(addrKey),
        })
      }
      if (!registerRateByIP.check(ip)) {
        return reply.status(429).send({
          error: 'Rate limit exceeded',
          retry_after_ms: registerRateByIP.retryAfterMs(ip),
        })
      }
    }

    const result = await handler.register(nonce, signature)

    if (result.error && !result.data) {
      return reply.status(result.status).send({ error: result.error })
    }
    if (result.status === 409) {
      return reply.status(409).send({
        error: result.error,
        conflict_id: result.data?.conflict_id,
      })
    }

    return reply.status(result.status).send(result.data)
  })
}

/** Clean up expired challenges — runs on startup + every 15 minutes */
export async function cleanupExpiredChallenges(db: DbClient): Promise<number> {
  const { rows } = await db.query(
    `DELETE FROM registration_challenges
     WHERE expires_at < now() - interval '1 hour'
     RETURNING nonce`,
  )
  return rows.length
}
```

- [ ] **Step 2: Run type check**

Run: `cd /c/lucid-agent-oracle && npx tsc --noEmit`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/identity-registration.ts
git commit -m "feat(4b): challenge + register route handlers with rate limiting"
```

---

## Chunk 3: Lucid Batch Resolver + Admin Endpoints

### Task 11: Lucid Batch Resolver Service

**Files:**
- Create: `apps/api/src/services/lucid-resolver.ts`
- Test: `apps/api/src/__tests__/lucid-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/__tests__/lucid-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LucidResolver } from '../services/lucid-resolver.js'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

describe('LucidResolver', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>
  let resolver: LucidResolver

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    resolver = new LucidResolver(db, producer)
    vi.clearAllMocks()
  })

  it('skips if advisory lock not acquired', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] })

    const result = await resolver.run()
    expect(result.skipped).toBe(true)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('creates new entity for tenant with no existing entity or wallet match', async () => {
    // 1. Advisory lock acquired
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query gateway_tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-1',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'base', address: '0xWALLET1' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check agent_entities for lucid_tenant
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Check wallet_mappings for any matching wallet
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Create entity
    db.query.mockResolvedValueOnce({ rows: [] })
    // 7. Insert evidence (RETURNING id)
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] })
    // 8. Check wallet mapping exists
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. Insert wallet mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. Upsert identity_link
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 12. Release advisory lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.skipped).toBe(false)
    expect(result.processed).toBe(1)
    expect(result.created).toBe(1)
  })

  it('enriches ERC-8004 entity with lucid_tenant (cross-source merge)', async () => {
    // 1. Advisory lock
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-2',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'base', address: '0xERC8004WALLET' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check lucid_tenant — not found
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Check wallet — mapped to ERC-8004 entity!
    db.query.mockResolvedValueOnce({ rows: [{ agent_entity: 'ae_erc8004' }] })
    // 6. Enrich entity (SET lucid_tenant)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_erc8004' }] })
    // 7. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 2 }] })
    // 8. Wallet already mapped to same entity — skip
    db.query.mockResolvedValueOnce({ rows: [{ agent_entity: 'ae_erc8004' }] })
    // 9. Upsert identity_link
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. Release lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.enriched).toBe(1)
  })

  it('creates conflict when wallet mapped to different entity', async () => {
    // 1. Advisory lock
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-3',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'base', address: '0xCONFLICT' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check lucid_tenant — not found
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Check wallet — not mapped (for entity lookup)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Create entity
    db.query.mockResolvedValueOnce({ rows: [] })
    // 7. Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 3 }] })
    // 8. Check wallet mapping — mapped to DIFFERENT entity!
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_other', confidence: 0.9 }],
    })
    // 9. Insert conflict
    db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] })
    // 10. Upsert identity_link
    db.query.mockResolvedValueOnce({ rows: [] })
    // 11. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 12. Release lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.conflicts).toBe(1)
  })

  it('is idempotent — existing entity reused', async () => {
    // 1. Advisory lock
    db.query.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    // 2. Query tenants
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'tenant-4',
        payment_config: JSON.stringify({
          wallets: [{ chain: 'solana', address: 'SOL111' }],
        }),
      }],
    })
    // 3. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Check lucid_tenant — FOUND existing entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    // 5. Insert evidence (dedup — ON CONFLICT DO NOTHING, no id returned)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. Fallback SELECT for evidence id
    db.query.mockResolvedValueOnce({ rows: [{ id: 7 }] })
    // 7. Check wallet mapping — already mapped to same entity
    db.query.mockResolvedValueOnce({ rows: [{ agent_entity: 'ae_existing' }] })
    // 8. Upsert identity_link (ON CONFLICT DO NOTHING)
    db.query.mockResolvedValueOnce({ rows: [] })
    // 9. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })
    // 10. Release lock
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolver.run()
    expect(result.processed).toBe(1)
    expect(result.created).toBe(0)
    expect(result.enriched).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/lucid-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/services/lucid-resolver.ts
import { nanoid } from 'nanoid'
import type { DbClient, RedpandaProducer } from '@lucid/oracle-core'
import { TOPICS } from '@lucid/oracle-core'

interface ResolverResult {
  skipped: boolean
  processed: number
  created: number
  enriched: number
  conflicts: number
}

export class LucidResolver {
  constructor(
    private readonly db: DbClient,
    private readonly producer: RedpandaProducer,
  ) {}

  async run(): Promise<ResolverResult> {
    // Acquire advisory lock
    const { rows: lockRows } = await this.db.query(
      "SELECT pg_try_advisory_lock(hashtext('lucid_resolver'))",
    )
    if (!lockRows[0]?.pg_try_advisory_lock) {
      return { skipped: true, processed: 0, created: 0, enriched: 0, conflicts: 0 }
    }

    const result: ResolverResult = { skipped: false, processed: 0, created: 0, enriched: 0, conflicts: 0 }

    try {
      // Query tenants with payment_config.wallets
      const { rows: tenants } = await this.db.query(
        `SELECT id, payment_config FROM gateway_tenants
         WHERE payment_config IS NOT NULL
         AND payment_config::jsonb->'wallets' IS NOT NULL`,
      )

      for (const tenant of tenants) {
        const config = typeof tenant.payment_config === 'string'
          ? JSON.parse(tenant.payment_config as string)
          : tenant.payment_config
        const wallets = config?.wallets as Array<{ chain: string; address: string }> | undefined
        if (!wallets || wallets.length === 0) continue

        await this.resolveTenant(tenant.id as string, wallets, result)
        result.processed++
      }
    } finally {
      // Release advisory lock
      await this.db.query("SELECT pg_advisory_unlock(hashtext('lucid_resolver'))").catch(() => {})
    }

    return result
  }

  private async resolveTenant(
    tenantId: string,
    wallets: Array<{ chain: string; address: string }>,
    result: ResolverResult,
  ): Promise<void> {
    await this.db.query('BEGIN')

    try {
      // Find or create entity
      let entityId: string

      // Check if entity already exists for this tenant
      const { rows: existingEntity } = await this.db.query(
        'SELECT id FROM agent_entities WHERE lucid_tenant = $1',
        [tenantId],
      )

      if (existingEntity.length > 0) {
        entityId = existingEntity[0].id as string
      } else {
        // Check if any wallet already maps to an ERC-8004 entity
        let foundErc8004Entity: string | null = null
        for (const w of wallets) {
          const { rows: mapped } = await this.db.query(
            `SELECT agent_entity FROM wallet_mappings
             WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
            [w.chain, w.address],
          )
          if (mapped.length > 0) {
            foundErc8004Entity = mapped[0].agent_entity as string
            break
          }
        }

        if (foundErc8004Entity) {
          // Cross-source merge: enrich existing ERC-8004 entity
          const { rows: enriched } = await this.db.query(
            `UPDATE agent_entities SET lucid_tenant = $1, updated_at = now()
             WHERE id = $2 AND lucid_tenant IS NULL
             RETURNING id`,
            [tenantId, foundErc8004Entity],
          )
          if (enriched.length === 0) {
            // Entity already has a different lucid_tenant — skip enrichment, create new entity instead
            console.warn(`[lucid-resolver] Entity ${foundErc8004Entity} already has a lucid_tenant, creating new entity for tenant ${tenantId}`)
            entityId = `ae_${nanoid()}`
            await this.db.query(
              'INSERT INTO agent_entities (id, lucid_tenant, created_at, updated_at) VALUES ($1, $2, now(), now())',
              [entityId, tenantId],
            )
            result.created++
          } else {
            entityId = foundErc8004Entity
            result.enriched++
          }
        } else {
          // Create new entity
          entityId = `ae_${nanoid()}`
          await this.db.query(
            'INSERT INTO agent_entities (id, lucid_tenant, created_at, updated_at) VALUES ($1, $2, now(), now())',
            [entityId, tenantId],
          )
          result.created++
        }
      }

      // Process each wallet
      const newSolanaWallets: string[] = []

      for (const w of wallets) {
        // Insert evidence (with dedup via ON CONFLICT DO NOTHING RETURNING id)
        const { rows: evidenceRows } = await this.db.query(
          `INSERT INTO identity_evidence
           (agent_entity, evidence_type, chain, address, metadata_json)
           VALUES ($1, 'gateway_correlation', $2, $3, $4)
           ON CONFLICT (agent_entity, evidence_type, chain, address)
           WHERE evidence_type = 'gateway_correlation' AND revoked_at IS NULL
           DO NOTHING
           RETURNING id`,
          [entityId, w.chain, w.address, JSON.stringify({ tenant_id: tenantId, source: 'payment_config' })],
        )

        let evidenceId: number
        if (evidenceRows.length > 0) {
          evidenceId = evidenceRows[0].id as number
        } else {
          // Fallback: SELECT existing evidence id
          const { rows: existing } = await this.db.query(
            `SELECT id FROM identity_evidence
             WHERE agent_entity = $1 AND evidence_type = 'gateway_correlation'
             AND chain = $2 AND LOWER(address) = LOWER($3) AND revoked_at IS NULL`,
            [entityId, w.chain, w.address],
          )
          if (!existing[0]?.id) {
            console.warn(`[lucid-resolver] Evidence dedup fallback returned no rows for ${w.chain}:${w.address}`)
            continue // skip this wallet — evidence dedup issue
          }
          evidenceId = existing[0].id as number
        }

        // Check wallet mapping
        const { rows: existingMapping } = await this.db.query(
          `SELECT agent_entity, confidence FROM wallet_mappings
           WHERE chain = $1 AND LOWER(address) = LOWER($2) AND removed_at IS NULL`,
          [w.chain, w.address],
        )

        if (existingMapping.length === 0) {
          // Not mapped — insert
          await this.db.query(
            `INSERT INTO wallet_mappings
             (agent_entity, chain, address, link_type, confidence, evidence_hash)
             VALUES ($1, $2, $3, 'lucid_passport', 1.0, NULL)`,
            [entityId, w.chain, w.address],
          )
          if (w.chain === 'solana') newSolanaWallets.push(w.address)
        } else if (existingMapping[0].agent_entity !== entityId) {
          // Mapped to different entity — conflict
          await this.db.query(
            `INSERT INTO identity_conflicts
             (chain, address, existing_entity, claiming_entity, existing_confidence, claiming_confidence, claim_evidence_id)
             VALUES ($1, $2, $3, $4, $5, 1.0, $6)`,
            [w.chain, w.address, existingMapping[0].agent_entity, entityId, existingMapping[0].confidence, evidenceId],
          )
          result.conflicts++
        }
        // If same entity — skip (idempotent)
      }

      // Upsert identity_link
      await this.db.query(
        `INSERT INTO identity_links (agent_entity, protocol, protocol_id, link_type, confidence)
         VALUES ($1, 'lucid', $2, 'gateway_correlation', 1.0)
         ON CONFLICT (protocol, protocol_id) DO NOTHING`,
        [entityId, tenantId],
      )

      await this.db.query('COMMIT')

      // Publish watchlist updates (after commit)
      for (const addr of newSolanaWallets) {
        await this.producer.publishJson(TOPICS.WATCHLIST, `watchlist:solana`, {
          action: 'add',
          chain: 'solana',
          address: addr,
          agent_entity_id: entityId,
        }).catch(() => {})
      }
    } catch (err) {
      await this.db.query('ROLLBACK').catch(() => {})
      throw err
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/lucid-resolver.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/lucid-resolver.ts apps/api/src/__tests__/lucid-resolver.test.ts
git commit -m "feat(4b): Lucid-native batch resolver with advisory lock + cross-source merge"
```

---

### Task 12: Admin Conflict Review Endpoints

**Files:**
- Create: `apps/api/src/routes/identity-admin.ts`
- Test: `apps/api/src/__tests__/conflict-review.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/api/src/__tests__/conflict-review.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Test the conflict resolution logic directly (not HTTP layer)
import { resolveConflict } from '../routes/identity-admin.js'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

describe('Admin conflict resolution', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    vi.clearAllMocks()
  })

  it('keep_existing: resolves conflict without mapping changes', async () => {
    // 1. Lookup conflict
    db.query.mockResolvedValueOnce({
      rows: [{ id: 1, status: 'open', chain: 'base', address: '0xABC', existing_entity: 'ae_1', claiming_entity: 'ae_2' }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. UPDATE identity_conflicts
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolveConflict(db, producer, 1, {
      resolution: 'keep_existing',
      resolved_by: 'admin-1',
      resolution_reason: 'Verified on-chain',
    })

    expect(result.status).toBe(200)
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE identity_conflicts'),
      expect.arrayContaining(['resolved', 'keep_existing', 'admin-1']),
    )
  })

  it('keep_claiming: soft-deletes existing mapping and creates new (in transaction)', async () => {
    // 1. Lookup conflict
    db.query.mockResolvedValueOnce({
      rows: [{ id: 2, status: 'open', chain: 'base', address: '0xDEF', existing_entity: 'ae_1', claiming_entity: 'ae_2' }],
    })
    // 2. BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // 3. Soft-delete existing mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 4. Insert new mapping
    db.query.mockResolvedValueOnce({ rows: [] })
    // 5. Resolve conflict
    db.query.mockResolvedValueOnce({ rows: [] })
    // 6. COMMIT
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolveConflict(db, producer, 2, {
      resolution: 'keep_claiming',
      resolved_by: 'admin-1',
      resolution_reason: 'Self-claim with signature proof',
    })

    expect(result.status).toBe(200)
    // Should publish watchlist updates after commit
    expect(producer.publishJson).toHaveBeenCalled()
  })

  it('rejects resolution of non-open conflict', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 3, status: 'resolved' }],
    })

    const result = await resolveConflict(db, producer, 3, {
      resolution: 'keep_existing',
      resolved_by: 'admin-1',
      resolution_reason: 'test',
    })

    expect(result.status).toBe(409)
    expect(result.error).toContain('already resolved')
  })

  it('returns 404 for missing conflict', async () => {
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await resolveConflict(db, producer, 999, {
      resolution: 'keep_existing',
      resolved_by: 'admin-1',
      resolution_reason: 'test',
    })

    expect(result.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/conflict-review.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api/src/routes/identity-admin.ts
import type { FastifyInstance } from 'fastify'
import type { DbClient, RedpandaProducer } from '@lucid/oracle-core'
import { TOPICS } from '@lucid/oracle-core'
import { LucidResolver } from '../services/lucid-resolver.js'

interface ResolveInput {
  resolution: 'keep_existing' | 'keep_claiming' | 'merge'
  resolved_by: string
  resolution_reason: string
}

interface ResolveResult {
  status: number
  error?: string
  data?: Record<string, unknown>
}

/** Exported for direct testing */
export async function resolveConflict(
  db: DbClient,
  producer: RedpandaProducer,
  conflictId: number,
  input: ResolveInput,
): Promise<ResolveResult> {
  const { rows } = await db.query(
    'SELECT * FROM identity_conflicts WHERE id = $1',
    [conflictId],
  )
  if (rows.length === 0) {
    return { status: 404, error: 'Conflict not found' }
  }

  const conflict = rows[0] as Record<string, any>
  if (conflict.status !== 'open') {
    return { status: 409, error: 'Conflict already resolved' }
  }

  // Wrap resolution in a transaction (especially important for keep_claiming
  // which does soft-delete + insert + status update atomically)
  await db.query('BEGIN')

  try {
    if (input.resolution === 'keep_claiming') {
      // Soft-delete existing mapping
      await db.query(
        `UPDATE wallet_mappings SET removed_at = now()
         WHERE chain = $1 AND LOWER(address) = LOWER($2)
         AND agent_entity = $3 AND removed_at IS NULL`,
        [conflict.chain, conflict.address, conflict.existing_entity],
      )

      // Create new mapping for claiming entity
      await db.query(
        `INSERT INTO wallet_mappings
         (agent_entity, chain, address, link_type, confidence, evidence_hash)
         VALUES ($1, $2, $3, 'self_claim', 1.0, NULL)`,
        [conflict.claiming_entity, conflict.chain, conflict.address],
      )
    }

    // Resolve conflict record
    await db.query(
      `UPDATE identity_conflicts
       SET status = $1, resolution = $2, resolved_by = $3,
           resolution_reason = $4, resolved_at = now()
       WHERE id = $5`,
      ['resolved', input.resolution, input.resolved_by, input.resolution_reason, conflictId],
    )

    await db.query('COMMIT')

    // Publish watchlist updates after commit (non-fatal side effects)
    if (input.resolution === 'keep_claiming') {
      const chain = conflict.chain as string
      if (chain === 'solana' || chain === 'base') {
        await producer.publishJson(TOPICS.WATCHLIST, `watchlist:${chain}`, {
          action: 'remove', chain, address: conflict.address,
          agent_entity_id: conflict.existing_entity,
        }).catch(() => {})
        await producer.publishJson(TOPICS.WATCHLIST, `watchlist:${chain}`, {
          action: 'add', chain, address: conflict.address,
          agent_entity_id: conflict.claiming_entity,
        }).catch(() => {})
      }
    }
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {})
    throw err
  }

  return { status: 200, data: { id: conflictId, resolution: input.resolution } }
}

export function registerAdminRoutes(
  app: FastifyInstance,
  db: DbClient,
  producer: RedpandaProducer,
  adminKey: string,
): void {
  // Admin key middleware
  const checkAdmin = (request: any, reply: any) => {
    if (request.headers['x-admin-key'] !== adminKey) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }

  // GET /v1/internal/identity/conflicts
  app.get('/v1/internal/identity/conflicts', async (request, reply) => {
    checkAdmin(request, reply)
    if (reply.sent) return

    const query = request.query as Record<string, string>
    const status = query.status ?? 'open'
    const limit = Math.min(parseInt(query.limit ?? '50', 10), 100)
    const offset = parseInt(query.offset ?? '0', 10)

    const { rows } = await db.query(
      `SELECT c.*, e.evidence_type, e.chain as evidence_chain
       FROM identity_conflicts c
       LEFT JOIN identity_evidence e ON c.claim_evidence_id = e.id
       WHERE c.status = $1
       ORDER BY c.created_at DESC
       LIMIT $2 OFFSET $3`,
      [status, limit, offset],
    )

    return reply.send({ conflicts: rows, limit, offset })
  })

  // GET /v1/internal/identity/conflicts/:id
  app.get('/v1/internal/identity/conflicts/:id', async (request, reply) => {
    checkAdmin(request, reply)
    if (reply.sent) return

    const { id } = request.params as { id: string }
    const { rows } = await db.query(
      `SELECT c.*,
              json_agg(DISTINCT jsonb_build_object(
                'id', e.id, 'evidence_type', e.evidence_type,
                'chain', e.chain, 'address', e.address, 'verified_at', e.verified_at
              )) FILTER (WHERE e.id IS NOT NULL) AS evidence
       FROM identity_conflicts c
       LEFT JOIN identity_evidence e
         ON e.agent_entity IN (c.existing_entity, c.claiming_entity)
         AND e.chain = c.chain AND LOWER(e.address) = LOWER(c.address)
       WHERE c.id = $1
       GROUP BY c.id`,
      [id],
    )

    if (rows.length === 0) return reply.status(404).send({ error: 'Conflict not found' })
    return reply.send(rows[0])
  })

  // PATCH /v1/internal/identity/conflicts/:id
  app.patch('/v1/internal/identity/conflicts/:id', async (request, reply) => {
    checkAdmin(request, reply)
    if (reply.sent) return

    const { id } = request.params as { id: string }
    const body = request.body as Record<string, string>
    const { resolution, resolution_reason } = body

    if (!resolution || !resolution_reason) {
      return reply.status(400).send({ error: 'resolution and resolution_reason required' })
    }

    const result = await resolveConflict(db, producer, parseInt(id, 10), {
      resolution: resolution as ResolveInput['resolution'],
      resolved_by: 'admin', // From admin key lookup
      resolution_reason,
    })

    return reply.status(result.status).send(result.error ? { error: result.error } : result.data)
  })

  // POST /v1/internal/identity/resolve-lucid
  app.post('/v1/internal/identity/resolve-lucid', async (request, reply) => {
    checkAdmin(request, reply)
    if (reply.sent) return

    const resolver = new LucidResolver(db, producer)
    const result = await resolver.run()
    return reply.send(result)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/conflict-review.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/identity-admin.ts apps/api/src/__tests__/conflict-review.test.ts
git commit -m "feat(4b): admin conflict review endpoints with resolution actions"
```

---

### Task 13: Race Condition Tests

**Files:**
- Create: `apps/api/src/__tests__/registration-race.test.ts`

- [ ] **Step 1: Write the race condition tests**

```typescript
// apps/api/src/__tests__/registration-race.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RegistrationHandler } from '../services/registration-handler.js'
import { VerifierRegistry } from '@lucid/oracle-core'

function mockDb() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) }
}

function mockProducer() {
  return { publishJson: vi.fn().mockResolvedValue(undefined) } as any
}

function mockVerifiers() {
  const reg = new VerifierRegistry()
  reg.register({ chains: ['base', 'ethereum'], verify: async () => true })
  reg.register({ chains: ['solana'], verify: async () => true })
  return reg
}

describe('Registration race conditions', () => {
  let db: ReturnType<typeof mockDb>
  let producer: ReturnType<typeof mockProducer>
  let handler: RegistrationHandler

  beforeEach(() => {
    db = mockDb()
    producer = mockProducer()
    handler = new RegistrationHandler(db, producer, mockVerifiers())
    vi.clearAllMocks()
  })

  it('concurrent nonce consumption — second attempt rejected as consumed', async () => {
    // First registration succeeds
    const validChallenge = {
      nonce: 'race-nonce', chain: 'base', address: '0xRACE',
      target_entity: null, auth_chain: null, auth_address: null,
      message: 'msg', environment: 'production',
      expires_at: new Date(Date.now() + 60_000),
      consumed_at: null,
    }

    // Second attempt sees consumed_at set
    db.query.mockResolvedValueOnce({
      rows: [{ ...validChallenge, consumed_at: new Date() }],
    })

    const result = await handler.register('race-nonce', '0xsig')
    expect(result.status).toBe(410)
    expect(result.error).toContain('consumed')
  })

  it('auth mapping revoked between challenge and registration', async () => {
    // Challenge has target_entity + auth
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-auth', chain: 'base', address: '0xNEW',
        target_entity: 'ae_target', auth_chain: 'base', auth_address: '0xAUTH',
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // Auth mapping check — REVOKED (empty)
    db.query.mockResolvedValueOnce({ rows: [] })
    // ROLLBACK
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('race-auth', '0xsig')
    expect(result.status).toBe(403)
    expect(result.error).toContain('Authorization expired')
  })

  it('wallet mapped by another registration between evidence and mapping insert', async () => {
    // New entity flow where wallet gets claimed between steps
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-wallet', chain: 'base', address: '0xCLAIMED',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    })
    // BEGIN
    db.query.mockResolvedValueOnce({ rows: [] })
    // Check existing entity — none
    db.query.mockResolvedValueOnce({ rows: [] })
    // Create entity
    db.query.mockResolvedValueOnce({ rows: [{ id: 'ae_late' }] })
    // Revoke old evidence
    db.query.mockResolvedValueOnce({ rows: [] })
    // Insert evidence
    db.query.mockResolvedValueOnce({ rows: [{ id: 50 }] })
    // Check mapping — NOW mapped to different entity (concurrent registration won)
    db.query.mockResolvedValueOnce({
      rows: [{ agent_entity: 'ae_winner', confidence: 1.0 }],
    })
    // Insert conflict
    db.query.mockResolvedValueOnce({ rows: [{ id: 77 }] })
    // Consume nonce
    db.query.mockResolvedValueOnce({ rows: [] })
    // COMMIT (entity + evidence + conflict persisted)
    db.query.mockResolvedValueOnce({ rows: [] })

    const result = await handler.register('race-wallet', '0xsig')
    expect(result.status).toBe(409)
  })

  it('challenge expires between issuance and registration', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        nonce: 'race-expire', chain: 'base', address: '0xLATE',
        target_entity: null, auth_chain: null, auth_address: null,
        message: 'msg', environment: 'production',
        expires_at: new Date(Date.now() - 1), // just expired
        consumed_at: null,
      }],
    })

    const result = await handler.register('race-expire', '0xsig')
    expect(result.status).toBe(410)
    expect(result.error).toContain('expired')
  })
})
```

- [ ] **Step 2: Run test**

Run: `cd /c/lucid-agent-oracle && npx vitest run apps/api/src/__tests__/registration-race.test.ts`
Expected: 4 tests PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/registration-race.test.ts
git commit -m "test(4b): race condition tests for registration flow"
```

---

## Chunk 4: Server Wiring + Full Integration

### Task 14: Wire Everything into server.ts

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add imports and verifier registration**

Add after the existing `import` block (after line 16):

```typescript
import { verifierRegistry, evmVerifier, solanaVerifier } from '@lucid/oracle-core'
import { registerIdentityRoutes, cleanupExpiredChallenges } from './routes/identity-registration.js'
import { registerAdminRoutes } from './routes/identity-admin.js'
import { LucidResolver } from './services/lucid-resolver.js'
```

- [ ] **Step 2: Register verifiers after adapter registration**

Add after `registerDefaultAdapters()` (after line 78):

```typescript
// Plan 4B: Register signature verifiers
verifierRegistry.register(evmVerifier)
verifierRegistry.register(solanaVerifier)
app.log.info(`Verifier registry: ${verifierRegistry.supportedChains().join(', ')}`)
```

- [ ] **Step 3: Wire registration + admin routes inside the DB block**

Add after the webhook auto-mounting section (after line 144), inside the `if (databaseUrl && redpandaBrokers)` block:

```typescript
  // Plan 4B: Self-registration + admin endpoints
  registerIdentityRoutes(app, client, resolverProducer)
  app.log.info('Identity registration routes mounted')

  const adminKey = process.env.ADMIN_KEY
  if (adminKey) {
    registerAdminRoutes(app, client, resolverProducer, adminKey)
    app.log.info('Identity admin routes mounted')
  }

  // Plan 4B: Lucid-native batch resolver (runs on startup + triggered via admin)
  const lucidResolver = new LucidResolver(client, resolverProducer)
  lucidResolver.run().then((result) => {
    if (result.skipped) {
      app.log.info('Lucid resolver: skipped (another instance running)')
    } else {
      app.log.info(`Lucid resolver: processed=${result.processed} created=${result.created} enriched=${result.enriched} conflicts=${result.conflicts}`)
    }
  }).catch((err) => {
    app.log.error('Lucid resolver startup error:', err)
  })

  // Plan 4B: Clean up expired challenges on startup + every 15 minutes
  cleanupExpiredChallenges(client).then((count) => {
    if (count > 0) app.log.info(`Cleaned up ${count} expired challenges`)
  }).catch(() => {})

  setInterval(() => {
    cleanupExpiredChallenges(client).catch(() => {})
  }, 15 * 60_000)
```

- [ ] **Step 4: Run type check**

Run: `cd /c/lucid-agent-oracle && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `cd /c/lucid-agent-oracle && npx vitest run`
Expected: All tests pass (~190 total)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(4b): wire registration routes, admin endpoints, Lucid resolver, and verifiers into server"
```

---

### Task 15: Final Verification + Documentation Update

**Files:**
- Modify: `docs/specs/2026-03-12-agent-economy-oracle-plan4b-self-registration-design.md`

- [ ] **Step 1: Run full test suite**

Run: `cd /c/lucid-agent-oracle && npx vitest run`
Expected: ~190+ tests pass, 0 failures

- [ ] **Step 2: Run type check**

Run: `cd /c/lucid-agent-oracle && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Update spec status to Implemented**

Change line 4:
```
**Status:** Draft — pending review
```
To:
```
**Status:** Implemented
```

- [ ] **Step 4: Commit**

```bash
git add docs/specs/2026-03-12-agent-economy-oracle-plan4b-self-registration-design.md
git commit -m "docs(4b): mark Plan 4B spec as Implemented"
```

- [ ] **Step 5: Verify success criteria**

Manually check each item from Section 10:
1. ✅ Lucid-native batch resolver populates agent_entities from gateway_tenants.payment_config
2. ✅ Cross-source merge enriches ERC-8004 entities with Lucid tenant links
3. ✅ Self-registration endpoint accepts EVM personal_sign and Solana Ed25519 proofs
4. ✅ Challenge lifecycle is replay-resistant (nonce consumed exactly once, 5-min expiry)
5. ✅ Existing entity attachment requires cryptographic proof (auth_signature)
6. ✅ All wallet conflicts logged to identity_conflicts, never silently resolved
7. ✅ Admin endpoints allow manual conflict review with full audit trail
8. ✅ identity_evidence table stores all proofs with dedup indexes
9. ✅ Advisory lock prevents concurrent batch resolver runs
10. ✅ Registration write path is transactional
11. ✅ ~41 new tests pass (190+ total)
