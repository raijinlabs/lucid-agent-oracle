# Plan 4A: External Adapters + Identity Resolution — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the identity and economic substrates (ERC-8004 indexer, wallet indexers, deterministic identity resolver) that make Agents a real, cross-protocol API noun.

**Architecture:** Ponder indexes Base ERC-8004 registries and wallet activity → Redpanda topics. Helius webhooks index Solana wallet activity → same pipeline. Identity resolver consumes ERC-8004 events, builds `agent_entities` / `wallet_mappings` / `identity_links` in Postgres, and emits watchlist updates. Resolver runs inside the API process as a Plan 4A simplification.

**Tech Stack:** Ponder (Base indexer), Helius (Solana webhooks + Enhanced Transactions API), KafkaJS (Redpanda), Supabase (Postgres), Vitest, nanoid

**Spec:** `docs/specs/2026-03-12-agent-economy-oracle-plan4a-adapters-identity-design.md`

---

## File Structure

### New files

```
packages/core/src/types/identity.ts        — ERC8004Event, WatchlistUpdate, AgentEntity types
packages/core/src/adapters/erc8004.ts       — ERC-8004 event normalization functions
packages/core/src/adapters/helius.ts        — Helius webhook normalization + backfill client
packages/core/src/__tests__/erc8004.test.ts — ERC-8004 adapter tests
packages/core/src/__tests__/helius.test.ts  — Helius adapter tests

migrations/supabase/20260312_agent_identity.sql — agent_entities, wallet_mappings, identity_links

apps/ponder/package.json
apps/ponder/tsconfig.json
apps/ponder/ponder.config.ts               — Base RPC, contract addresses, ABIs
apps/ponder/ponder.schema.ts               — Minimal Ponder schema
apps/ponder/src/erc8004-identity.ts         — Identity Registry handler
apps/ponder/src/erc8004-reputation.ts       — Reputation Registry handler
apps/ponder/src/wallet-activity.ts          — Wallet activity handler (broad index + filter)
apps/ponder/src/redpanda-sink.ts            — Shared Redpanda producer

apps/api/src/routes/helius-webhook.ts       — POST /v1/internal/helius/webhook
apps/api/src/services/identity-resolver.ts  — Event-driven resolver (Redpanda consumer)
apps/api/src/services/wallet-watchlist.ts   — Helius + Ponder watchlist management
apps/api/src/__tests__/identity-resolver.test.ts
apps/api/src/__tests__/helius-webhook.test.ts
apps/api/src/__tests__/wallet-watchlist.test.ts
```

### Modified files

```
packages/core/src/types/events.ts           — Add 'erc8004' source, 'transfer'/'contract_interaction' event types
packages/core/src/types/index.ts            — Re-export identity types
packages/core/src/index.ts                  — Export new adapters + types
packages/core/src/clients/redpanda.ts       — Add WATCHLIST topic
apps/api/src/server.ts                      — Wire resolver + Helius webhook
apps/api/package.json                       — Add nanoid dependency
Dockerfile                                  — Add ponder target
```

---

## Chunk 1: Core Types + Adapters

### Task 1: Update Core Event Types

**Files:**
- Modify: `packages/core/src/types/events.ts`

- [ ] **Step 1: Add `erc8004` source and new event types**

In `packages/core/src/types/events.ts`, update the `EventSource` type:

Change:
```typescript
  | 'erc8004_eth'
```
To:
```typescript
  | 'erc8004'
```

> **Convention:** The source is `'erc8004'` without a chain suffix. The chain is tracked in the separate `chain` field (e.g., `chain: 'base'`). This matches the design spec and the `ERC8004Event` type which uses `source: 'erc8004'`.

Add to `EventType`:
```typescript
  | 'transfer'
  | 'contract_interaction'
```

- [ ] **Step 2: Run tests to verify no breakage**

Run: `npx vitest run`
Expected: All 88 tests pass (nothing uses `erc8004_eth` yet)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types/events.ts
git commit -m "feat: add erc8004 source + transfer/contract_interaction event types"
```

---

### Task 2: Identity Types + ERC-8004 Adapter

**Files:**
- Create: `packages/core/src/types/identity.ts`
- Create: `packages/core/src/adapters/erc8004.ts`
- Create: `packages/core/src/__tests__/erc8004.test.ts`
- Modify: `packages/core/src/types/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the identity types**

Create `packages/core/src/types/identity.ts`:

```typescript
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

export type WalletLinkType = 'erc8004_tba' | 'erc8004_owner' | 'lucid_passport'

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
```

- [ ] **Step 2: Write the ERC-8004 adapter tests**

Create `packages/core/src/__tests__/erc8004.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  normalizeAgentRegistered,
  normalizeAgentUpdated,
  normalizeOwnershipTransferred,
  normalizeReputationUpdated,
} from '../adapters/erc8004.js'

const BASE_LOG = {
  block_number: 12345678,
  tx_hash: '0xabc123def456',
  log_index: 0,
  timestamp: new Date('2026-03-12T00:00:00Z'),
}

describe('ERC-8004 adapter', () => {
  it('normalizes AgentRegistered event', () => {
    const event = normalizeAgentRegistered({
      ...BASE_LOG,
      agent_id: '0x0001',
      owner_address: '0xOwner123',
      tba_address: '0xTBA456',
      raw_data: '{}',
    })
    expect(event.event_type).toBe('agent_registered')
    expect(event.source).toBe('erc8004')
    expect(event.chain).toBe('base')
    expect(event.agent_id).toBe('0x0001')
    expect(event.owner_address).toBe('0xOwner123')
    expect(event.tba_address).toBe('0xTBA456')
    expect(event.event_id).toMatch(/^[0-9a-f]{8}-/)
  })

  it('normalizes AgentRegistered with null TBA', () => {
    const event = normalizeAgentRegistered({
      ...BASE_LOG,
      agent_id: '0x0002',
      owner_address: '0xOwner789',
      tba_address: null,
      raw_data: '{}',
    })
    expect(event.tba_address).toBeNull()
  })

  it('normalizes AgentUpdated event', () => {
    const event = normalizeAgentUpdated({
      ...BASE_LOG,
      agent_id: '0x0001',
      owner_address: '0xOwner123',
      raw_data: '{"name":"Agent Alpha"}',
    })
    expect(event.event_type).toBe('agent_updated')
    expect(event.reputation_score).toBeNull()
  })

  it('normalizes OwnershipTransferred event', () => {
    const event = normalizeOwnershipTransferred({
      ...BASE_LOG,
      agent_id: '0x0001',
      old_owner: '0xOldOwner',
      new_owner: '0xNewOwner',
      raw_data: '{}',
    })
    expect(event.event_type).toBe('ownership_transferred')
    expect(event.owner_address).toBe('0xNewOwner')
  })

  it('normalizes ReputationUpdated event', () => {
    const event = normalizeReputationUpdated({
      ...BASE_LOG,
      agent_id: '0x0001',
      owner_address: '0xOwner123',
      reputation_score: 8500,
      validator_address: '0xValidator',
      evidence_hash: '0xEvidence',
      raw_data: '{}',
    })
    expect(event.event_type).toBe('reputation_updated')
    expect(event.reputation_score).toBe(8500)
    expect(event.validator_address).toBe('0xValidator')
  })

  it('produces deterministic event_ids', () => {
    const a = normalizeAgentRegistered({ ...BASE_LOG, agent_id: '0x01', owner_address: '0xA', tba_address: null, raw_data: '{}' })
    const b = normalizeAgentRegistered({ ...BASE_LOG, agent_id: '0x01', owner_address: '0xA', tba_address: null, raw_data: '{}' })
    expect(a.event_id).toBe(b.event_id)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/__tests__/erc8004.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the ERC-8004 adapter**

Create `packages/core/src/adapters/erc8004.ts`:

```typescript
import { computeEventId } from '../types/events.js'
import type { ERC8004Event } from '../types/identity.js'

interface BaseLogFields {
  block_number: number
  tx_hash: string
  log_index: number
  timestamp: Date
}

export function normalizeAgentRegistered(input: BaseLogFields & {
  agent_id: string
  owner_address: string
  tba_address: string | null
  raw_data: string
}): ERC8004Event {
  return {
    event_id: computeEventId('erc8004', 'base', input.tx_hash, input.log_index),
    event_type: 'agent_registered',
    source: 'erc8004',
    chain: 'base',
    block_number: input.block_number,
    tx_hash: input.tx_hash,
    log_index: input.log_index,
    timestamp: input.timestamp,
    agent_id: input.agent_id,
    owner_address: input.owner_address,
    tba_address: input.tba_address,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: input.raw_data,
  }
}

export function normalizeAgentUpdated(input: BaseLogFields & {
  agent_id: string
  owner_address: string
  raw_data: string
}): ERC8004Event {
  return {
    event_id: computeEventId('erc8004', 'base', input.tx_hash, input.log_index),
    event_type: 'agent_updated',
    source: 'erc8004',
    chain: 'base',
    block_number: input.block_number,
    tx_hash: input.tx_hash,
    log_index: input.log_index,
    timestamp: input.timestamp,
    agent_id: input.agent_id,
    owner_address: input.owner_address,
    tba_address: null,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: input.raw_data,
  }
}

export function normalizeOwnershipTransferred(input: BaseLogFields & {
  agent_id: string
  old_owner: string
  new_owner: string
  raw_data: string
}): ERC8004Event {
  return {
    event_id: computeEventId('erc8004', 'base', input.tx_hash, input.log_index),
    event_type: 'ownership_transferred',
    source: 'erc8004',
    chain: 'base',
    block_number: input.block_number,
    tx_hash: input.tx_hash,
    log_index: input.log_index,
    timestamp: input.timestamp,
    agent_id: input.agent_id,
    owner_address: input.new_owner,
    tba_address: null,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: input.raw_data,
  }
}

export function normalizeReputationUpdated(input: BaseLogFields & {
  agent_id: string
  owner_address: string
  reputation_score: number
  validator_address: string
  evidence_hash: string
  raw_data: string
}): ERC8004Event {
  return {
    event_id: computeEventId('erc8004', 'base', input.tx_hash, input.log_index),
    event_type: 'reputation_updated',
    source: 'erc8004',
    chain: 'base',
    block_number: input.block_number,
    tx_hash: input.tx_hash,
    log_index: input.log_index,
    timestamp: input.timestamp,
    agent_id: input.agent_id,
    owner_address: input.owner_address,
    tba_address: null,
    reputation_score: input.reputation_score,
    validator_address: input.validator_address,
    evidence_hash: input.evidence_hash,
    raw_data: input.raw_data,
  }
}
```

- [ ] **Step 5: Update type exports**

In `packages/core/src/types/index.ts`, add:
```typescript
export * from './identity.js'
```

In `packages/core/src/index.ts`, add:
```typescript
// Identity
export type { ERC8004Event, ERC8004EventType, WatchlistUpdate, AgentEntity, WalletMapping, WalletLinkType, IdentityLink } from './types/identity.js'

// Adapters (ERC-8004)
export {
  normalizeAgentRegistered,
  normalizeAgentUpdated,
  normalizeOwnershipTransferred,
  normalizeReputationUpdated,
} from './adapters/erc8004.js'
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run`
Expected: All pass including 6 new ERC-8004 tests

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types/identity.ts packages/core/src/adapters/erc8004.ts packages/core/src/__tests__/erc8004.test.ts packages/core/src/types/index.ts packages/core/src/index.ts
git commit -m "feat: add ERC-8004 identity types + adapter normalizers"
```

---

### Task 3: Helius Adapter + Watchlist Topic

**Files:**
- Create: `packages/core/src/adapters/helius.ts`
- Create: `packages/core/src/__tests__/helius.test.ts`
- Modify: `packages/core/src/clients/redpanda.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add WATCHLIST topic**

In `packages/core/src/clients/redpanda.ts`, add to the `TOPICS` object:

```typescript
  WATCHLIST: 'wallet_watchlist.updated',
```

- [ ] **Step 2: Write the Helius adapter tests**

Create `packages/core/src/__tests__/helius.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { normalizeHeliusTransaction } from '../adapters/helius.js'

describe('Helius adapter', () => {
  it('normalizes a SOL transfer', () => {
    const event = normalizeHeliusTransaction({
      signature: '5abc123',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 12345,
      nativeTransfers: [
        { fromUserAccount: 'SolWallet1', toUserAccount: 'SolWallet2', amount: 1_000_000_000 },
      ],
      tokenTransfers: [],
      accountData: [],
      description: 'SOL transfer',
    }, 'SolWallet1')
    expect(event).not.toBeNull()
    expect(event!.source).toBe('agent_wallets_sol')
    expect(event!.chain).toBe('solana')
    expect(event!.event_type).toBe('transfer')
    expect(event!.subject_raw_id).toBe('SolWallet1')
    expect(event!.counterparty_raw_id).toBe('SolWallet2')
    expect(event!.amount).toBe('1000000000')
    expect(event!.currency).toBe('SOL')
    expect(event!.protocol).toBe('independent')
    expect(event!.economic_authentic).toBe(true)
  })

  it('normalizes a SPL token transfer', () => {
    const event = normalizeHeliusTransaction({
      signature: '5def456',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 12346,
      nativeTransfers: [],
      tokenTransfers: [
        { fromUserAccount: 'SolWallet1', toUserAccount: 'SolWallet3', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenAmount: 100, tokenStandard: 'Fungible' },
      ],
      accountData: [],
      description: 'USDC transfer',
    }, 'SolWallet1')
    expect(event).not.toBeNull()
    expect(event!.currency).toBe('USDC')
    expect(event!.amount).toBe('100')
  })

  it('returns null for transactions not involving watched wallet', () => {
    const event = normalizeHeliusTransaction({
      signature: '5ghi789',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 12347,
      nativeTransfers: [
        { fromUserAccount: 'Other1', toUserAccount: 'Other2', amount: 500 },
      ],
      tokenTransfers: [],
      accountData: [],
      description: 'unrelated transfer',
    }, 'SolWallet1')
    expect(event).toBeNull()
  })

  it('produces deterministic event IDs', () => {
    const input = {
      signature: '5abc123',
      type: 'TRANSFER' as const,
      timestamp: 1710288000,
      slot: 12345,
      nativeTransfers: [{ fromUserAccount: 'W1', toUserAccount: 'W2', amount: 100 }],
      tokenTransfers: [],
      accountData: [],
      description: '',
    }
    const a = normalizeHeliusTransaction(input, 'W1')
    const b = normalizeHeliusTransaction(input, 'W1')
    expect(a!.event_id).toBe(b!.event_id)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/__tests__/helius.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the Helius adapter**

Create `packages/core/src/adapters/helius.ts`:

```typescript
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
```

- [ ] **Step 5: Update exports**

In `packages/core/src/index.ts`, add:
```typescript
// Adapters (Helius)
export { normalizeHeliusTransaction, verifyHeliusSignature, type HeliusTransaction } from './adapters/helius.js'
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run`
Expected: All pass including 4 new Helius tests

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/adapters/helius.ts packages/core/src/__tests__/helius.test.ts packages/core/src/clients/redpanda.ts packages/core/src/index.ts
git commit -m "feat: add Helius adapter normalizer + WATCHLIST topic"
```

---

## Chunk 2: Infrastructure

### Task 4: Supabase Migration — Agent Identity Tables

**Files:**
- Create: `migrations/supabase/20260312_agent_identity.sql`

- [ ] **Step 1: Write the migration**

Create `migrations/supabase/20260312_agent_identity.sql`:

```sql
-- Plan 4A: Agent Identity Tables
-- Creates agent_entities, wallet_mappings, and identity_links tables
-- for the deterministic identity resolver.

-- Canonical agent identity records
CREATE TABLE IF NOT EXISTS agent_entities (
  id                    TEXT PRIMARY KEY,
  display_name          TEXT,
  erc8004_id            TEXT UNIQUE,
  lucid_tenant          TEXT,
  reputation_json       JSONB,
  reputation_updated_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_entities_erc8004
  ON agent_entities(erc8004_id) WHERE erc8004_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_entities_lucid
  ON agent_entities(lucid_tenant) WHERE lucid_tenant IS NOT NULL;

-- Wallet → agent entity resolution
CREATE TABLE IF NOT EXISTS wallet_mappings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity  TEXT NOT NULL REFERENCES agent_entities(id),
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  link_type     TEXT NOT NULL,
  confidence    REAL DEFAULT 1.0,
  evidence_hash TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  removed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_mappings_active_address
  ON wallet_mappings(chain, address) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_mappings_entity
  ON wallet_mappings(agent_entity);

-- Cross-protocol identity links
CREATE TABLE IF NOT EXISTS identity_links (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity    TEXT NOT NULL REFERENCES agent_entities(id),
  protocol        TEXT NOT NULL,
  protocol_id     TEXT NOT NULL,
  link_type       TEXT NOT NULL,
  confidence      REAL DEFAULT 1.0,
  evidence_json   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (protocol, protocol_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_links_entity
  ON identity_links(agent_entity);
```

- [ ] **Step 2: Commit**

```bash
git add migrations/supabase/20260312_agent_identity.sql
git commit -m "feat: add agent_entities, wallet_mappings, identity_links migration"
```

---

### Task 5: Ponder Project Scaffold

**Files:**
- Create: `apps/ponder/package.json`
- Create: `apps/ponder/tsconfig.json`
- Create: `apps/ponder/ponder.config.ts`
- Create: `apps/ponder/ponder.schema.ts`

- [ ] **Step 1: Create package.json**

Create `apps/ponder/package.json`:

```json
{
  "name": "@lucid/oracle-ponder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "ponder dev",
    "start": "ponder start",
    "codegen": "ponder codegen"
  },
  "dependencies": {
    "@ponder/core": "^0.7.0",
    "hono": "^4.0.0",
    "kafkajs": "^2.2.0",
    "viem": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `apps/ponder/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["ponder.config.ts", "ponder.schema.ts", "src/**/*.ts"]
}
```

- [ ] **Step 3: Create ponder.config.ts**

Create `apps/ponder/ponder.config.ts`:

```typescript
import { createConfig } from '@ponder/core'
import { http } from 'viem'

// ERC-8004 Identity Registry ABI (relevant events only)
const IDENTITY_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'AgentRegistered',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'tba', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AgentUpdated',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'metadataUri', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'previousOwner', type: 'address', indexed: true },
      { name: 'newOwner', type: 'address', indexed: true },
    ],
  },
] as const

// ERC-8004 Reputation Registry ABI (relevant events only)
const REPUTATION_REGISTRY_ABI = [
  {
    type: 'event',
    name: 'ReputationUpdated',
    inputs: [
      { name: 'agentId', type: 'bytes32', indexed: true },
      { name: 'score', type: 'uint256', indexed: false },
      { name: 'validator', type: 'address', indexed: true },
      { name: 'evidenceHash', type: 'bytes32', indexed: false },
    ],
  },
] as const

// Base USDC contract for wallet activity tracking
const ERC20_TRANSFER_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

export default createConfig({
  networks: {
    base: {
      chainId: 8453,
      transport: http(process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'),
    },
  },
  contracts: {
    IdentityRegistry: {
      network: 'base',
      abi: IDENTITY_REGISTRY_ABI,
      address: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      startBlock: 20_000_000, // TODO: set to actual deployment block
    },
    ReputationRegistry: {
      network: 'base',
      abi: REPUTATION_REGISTRY_ABI,
      address: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
      startBlock: 20_000_000, // TODO: set to actual deployment block
    },
    // Broad index: all USDC transfers on Base (filtered by watchlist in handler)
    BaseUSDC: {
      network: 'base',
      abi: ERC20_TRANSFER_ABI,
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
      startBlock: 20_000_000,
    },
  },
})
```

- [ ] **Step 4: Create minimal Ponder schema**

Create `apps/ponder/ponder.schema.ts`:

```typescript
import { onchainTable } from '@ponder/core'

// Minimal schema — Ponder requires at least one table.
// We use Ponder as adapter-only (publish to Redpanda, not store here),
// but need a schema to satisfy Ponder's startup requirements.
export const indexerState = onchainTable('indexer_state', (t) => ({
  key: t.text().primaryKey(),
  value: t.text(),
}))
```

- [ ] **Step 5: Commit**

```bash
git add apps/ponder/
git commit -m "feat: scaffold Ponder project for Base ERC-8004 + wallet indexing"
```

---

### Task 6: Ponder Redpanda Sink + Handlers

**Files:**
- Create: `apps/ponder/src/redpanda-sink.ts`
- Create: `apps/ponder/src/erc8004-identity.ts`
- Create: `apps/ponder/src/erc8004-reputation.ts`
- Create: `apps/ponder/src/wallet-activity.ts`

- [ ] **Step 1: Create the shared Redpanda sink**

Create `apps/ponder/src/redpanda-sink.ts`:

```typescript
import { Kafka, type Producer } from 'kafkajs'

const TOPICS = {
  ERC8004: 'raw.erc8004.events',
  AGENT_WALLETS: 'raw.agent_wallets.events',
}

let producer: Producer | null = null

export async function getProducer(): Promise<Producer> {
  if (producer) return producer

  const kafka = new Kafka({
    clientId: 'oracle-ponder-indexer',
    brokers: (process.env.REDPANDA_BROKERS ?? 'localhost:9092').split(','),
  })

  producer = kafka.producer()
  await producer.connect()
  return producer
}

export async function publishToERC8004(key: string, event: unknown): Promise<void> {
  const p = await getProducer()
  await p.send({
    topic: TOPICS.ERC8004,
    messages: [{ key, value: JSON.stringify(event) }],
  })
}

export async function publishToWalletActivity(key: string, event: unknown): Promise<void> {
  const p = await getProducer()
  await p.send({
    topic: TOPICS.AGENT_WALLETS,
    messages: [{ key, value: JSON.stringify(event) }],
  })
}
```

- [ ] **Step 2: Create the ERC-8004 Identity handler**

Create `apps/ponder/src/erc8004-identity.ts`:

```typescript
import { ponder } from '@/generated'
import { publishToERC8004 } from './redpanda-sink'
import { computeEventId } from '../../../packages/core/src/types/events'

ponder.on('IdentityRegistry:AgentRegistered', async ({ event, context }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'agent_registered',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: event.args.owner,
    tba_address: event.args.tba === '0x0000000000000000000000000000000000000000' ? null : event.args.tba,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: JSON.stringify(event.args),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})

ponder.on('IdentityRegistry:AgentUpdated', async ({ event }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'agent_updated',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: '',
    tba_address: null,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: JSON.stringify(event.args),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})

ponder.on('IdentityRegistry:OwnershipTransferred', async ({ event }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'ownership_transferred',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: event.args.newOwner,
    tba_address: null,
    reputation_score: null,
    validator_address: null,
    evidence_hash: null,
    raw_data: JSON.stringify({ ...event.args, old_owner: event.args.previousOwner }),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})
```

- [ ] **Step 3: Create the ERC-8004 Reputation handler**

Create `apps/ponder/src/erc8004-reputation.ts`:

```typescript
import { ponder } from '@/generated'
import { publishToERC8004 } from './redpanda-sink'
import { computeEventId } from '../../../packages/core/src/types/events'

ponder.on('ReputationRegistry:ReputationUpdated', async ({ event }) => {
  const erc8004Event = {
    event_id: computeEventId('erc8004', 'base', event.transaction.hash, Number(event.log.logIndex)),
    event_type: 'reputation_updated',
    source: 'erc8004',
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    agent_id: event.args.agentId,
    owner_address: '',
    tba_address: null,
    reputation_score: Number(event.args.score),
    validator_address: event.args.validator,
    evidence_hash: event.args.evidenceHash,
    raw_data: JSON.stringify(event.args),
  }
  await publishToERC8004(`erc8004:${event.args.agentId}`, erc8004Event)
})
```

- [ ] **Step 4: Create the wallet activity handler**

Create `apps/ponder/src/wallet-activity.ts`:

```typescript
import { ponder } from '@/generated'
import { publishToWalletActivity } from './redpanda-sink'
import { computeEventId } from '../../../packages/core/src/types/events'

/**
 * In-memory watchlist of known agent wallets on Base.
 * Loaded from Postgres on startup, refreshed via wallet_watchlist.updated Redpanda topic.
 * Ponder indexes ALL USDC transfers; this set filters to agent wallets only.
 *
 * Refresh path: resolver publishes wallet_watchlist.updated → this consumer
 * reloads the full set from Postgres. We reload from DB (not just apply the delta)
 * to stay consistent even if messages are missed or replayed.
 */
const watchedAddresses = new Set<string>()

/** Load watched addresses from Postgres wallet_mappings table. */
async function loadWatchlist(dbUrl: string): Promise<void> {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  try {
    const result = await client.query(
      `SELECT LOWER(address) as address FROM wallet_mappings WHERE chain = 'base' AND removed_at IS NULL`
    )
    watchedAddresses.clear()
    for (const row of result.rows) {
      watchedAddresses.add(row.address)
    }
    console.log(`[ponder] Loaded ${watchedAddresses.size} watched Base addresses`)
  } finally {
    await client.end()
  }
}

/** Start a KafkaJS consumer that listens for wallet_watchlist.updated events
 *  and reloads the in-memory watchlist from Postgres when any arrive. */
async function startWatchlistConsumer(dbUrl: string, brokers: string[]): Promise<void> {
  const { Kafka } = await import('kafkajs')
  const kafka = new Kafka({ clientId: 'oracle-ponder-watchlist', brokers })
  const consumer = kafka.consumer({ groupId: 'oracle-ponder-watchlist' })
  await consumer.connect()
  await consumer.subscribe({ topic: 'wallet_watchlist.updated', fromBeginning: false })
  await consumer.run({
    eachMessage: async () => {
      // On any watchlist update, reload the full set from Postgres.
      // This is safe because loadWatchlist clears + rebuilds the set.
      await loadWatchlist(dbUrl)
    },
  })
  console.log('[ponder] Watchlist consumer started — listening for wallet_watchlist.updated')
}

// Initialize on module load
const DB_URL = process.env.DATABASE_URL
const BROKERS = (process.env.REDPANDA_BROKERS ?? 'localhost:9092').split(',')
if (DB_URL) {
  loadWatchlist(DB_URL)
    .then(() => startWatchlistConsumer(DB_URL, BROKERS))
    .catch((err) => {
      console.error('[ponder] Failed to init watchlist:', err.message)
    })
}

ponder.on('BaseUSDC:Transfer', async ({ event }) => {
  const from = event.args.from.toLowerCase()
  const to = event.args.to.toLowerCase()

  // Filter: at least one side must be a watched agent wallet
  const isFromWatched = watchedAddresses.has(from)
  const isToWatched = watchedAddresses.has(to)
  if (!isFromWatched && !isToWatched) return

  const subject = isFromWatched ? from : to
  const counterparty = isFromWatched ? to : from

  const rawEvent = {
    event_id: computeEventId('agent_wallets_evm', 'base', event.transaction.hash, Number(event.log.logIndex)),
    source: 'agent_wallets_evm',
    source_adapter_ver: 1,
    ingestion_type: 'realtime',
    ingestion_ts: new Date().toISOString(),
    chain: 'base',
    block_number: Number(event.block.number),
    tx_hash: event.transaction.hash,
    log_index: Number(event.log.logIndex),
    event_type: 'transfer',
    event_timestamp: new Date(Number(event.block.timestamp) * 1000).toISOString(),
    subject_entity_id: null,
    subject_raw_id: subject,
    subject_id_type: 'wallet',
    counterparty_raw_id: counterparty,
    protocol: 'independent',
    amount: event.args.value.toString(),
    currency: 'USDC',
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
  await publishToWalletActivity(`base:${subject}`, rawEvent)
})
```

- [ ] **Step 5: Commit**

```bash
git add apps/ponder/src/
git commit -m "feat: add Ponder handlers — ERC-8004 identity/reputation + wallet activity"
```

---

## Chunk 3: API Integration

### Task 7: Helius Webhook Route

**Files:**
- Create: `apps/api/src/routes/helius-webhook.ts`
- Create: `apps/api/src/__tests__/helius-webhook.test.ts`

- [ ] **Step 1: Write the Helius webhook tests**

Create `apps/api/src/__tests__/helius-webhook.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleHeliusWebhook, verifyHeliusHmac } from '../routes/helius-webhook.js'

describe('Helius webhook', () => {
  it('verifies valid HMAC signature', () => {
    const body = '{"test":"data"}'
    const { createHmac } = require('node:crypto')
    const secret = 'test-secret-123'
    const sig = createHmac('sha256', secret).update(body).digest('hex')
    expect(verifyHeliusHmac(body, sig, secret)).toBe(true)
  })

  it('rejects invalid HMAC signature', () => {
    expect(verifyHeliusHmac('{"test":"data"}', 'bad-sig', 'secret')).toBe(false)
  })

  it('normalizes webhook payload into events', () => {
    const watchedWallets = new Set(['SolWallet1'])
    const tx = {
      signature: '5abc',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 100,
      nativeTransfers: [{ fromUserAccount: 'SolWallet1', toUserAccount: 'SolWallet2', amount: 1e9 }],
      tokenTransfers: [],
      accountData: [],
      description: '',
    }
    const events = handleHeliusWebhook([tx], watchedWallets)
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('agent_wallets_sol')
    expect(events[0].subject_raw_id).toBe('SolWallet1')
  })

  it('skips transactions not involving watched wallets', () => {
    const watchedWallets = new Set(['SolWallet1'])
    const tx = {
      signature: '5def',
      type: 'TRANSFER',
      timestamp: 1710288000,
      slot: 101,
      nativeTransfers: [{ fromUserAccount: 'Other1', toUserAccount: 'Other2', amount: 500 }],
      tokenTransfers: [],
      accountData: [],
      description: '',
    }
    const events = handleHeliusWebhook([tx], watchedWallets)
    expect(events).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/__tests__/helius-webhook.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the Helius webhook handler**

Create `apps/api/src/routes/helius-webhook.ts`:

```typescript
import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { normalizeHeliusTransaction, type HeliusTransaction } from '@lucid/oracle-core'
import type { RawEconomicEvent } from '@lucid/oracle-core'
import type { RedpandaProducer } from '@lucid/oracle-core'

/** Verify Helius HMAC-SHA256 webhook signature */
export function verifyHeliusHmac(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  return expected === signature
}

/** Process Helius webhook payload — normalize and filter by watched wallets */
export function handleHeliusWebhook(
  transactions: HeliusTransaction[],
  watchedWallets: Set<string>,
): RawEconomicEvent[] {
  const events: RawEconomicEvent[] = []
  for (const tx of transactions) {
    for (const wallet of watchedWallets) {
      const event = normalizeHeliusTransaction(tx, wallet)
      if (event) {
        events.push(event)
        break // one event per tx is enough
      }
    }
  }
  return events
}

/**
 * Register the Helius webhook route.
 *
 * Producer method note: Uses `publishEvents()` for RawEconomicEvent[] arrays
 * (wallet activity). The identity resolver uses `publishJson()` for
 * WatchlistUpdate messages. Both methods exist on RedpandaProducer.
 */
export function registerHeliusWebhook(
  app: FastifyInstance,
  producer: RedpandaProducer,
  watchedWallets: Set<string>,
  webhookSecret: string,
): void {
  app.post('/v1/internal/helius/webhook', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const signature = request.headers['x-helius-signature'] as string | undefined
    if (!signature || !verifyHeliusHmac(JSON.stringify(request.body), signature, webhookSecret)) {
      return reply.status(401).send({ error: 'Invalid webhook signature' })
    }

    const transactions = request.body as HeliusTransaction[]
    const events = handleHeliusWebhook(transactions, watchedWallets)

    if (events.length > 0) {
      await producer.publishEvents('raw.agent_wallets.events', events)
    }

    return { processed: events.length }
  })
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: All pass including 4 new webhook tests

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/helius-webhook.ts apps/api/src/__tests__/helius-webhook.test.ts
git commit -m "feat: add Helius webhook route with HMAC auth"
```

---

### Task 8: Identity Resolver

**Files:**
- Create: `apps/api/src/services/identity-resolver.ts`
- Create: `apps/api/src/__tests__/identity-resolver.test.ts`

- [ ] **Step 1: Write the identity resolver tests**

Create `apps/api/src/__tests__/identity-resolver.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IdentityResolver } from '../services/identity-resolver.js'
import type { ERC8004Event } from '@lucid/oracle-core'

const mockDb = {
  query: vi.fn(),
}

const mockProducer = {
  publishJson: vi.fn().mockResolvedValue(undefined),
}

function makeResolver() {
  return new IdentityResolver(mockDb as any, mockProducer as any)
}

const baseEvent: ERC8004Event = {
  event_id: 'test-uuid',
  event_type: 'agent_registered',
  source: 'erc8004',
  chain: 'base',
  block_number: 100,
  tx_hash: '0xabc',
  log_index: 0,
  timestamp: new Date('2026-03-12T00:00:00Z'),
  agent_id: '0x0001',
  owner_address: '0xOwner',
  tba_address: '0xTBA',
  reputation_score: null,
  validator_address: null,
  evidence_hash: null,
  raw_data: '{}',
}

describe('IdentityResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates agent_entity for new AgentRegistered', async () => {
    const resolver = makeResolver()
    // No existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT agent_entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_test123' }] })
    // INSERT wallet_mapping for TBA
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT wallet_mapping for owner
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT identity_link
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(baseEvent)

    // Check agent_entity was created
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_entities'),
      expect.any(Array),
    )
    // Check watchlist update published
    expect(mockProducer.publishJson).toHaveBeenCalledWith(
      'wallet_watchlist.updated',
      expect.any(String),
      expect.objectContaining({ action: 'add', chain: 'base' }),
    )
  })

  it('skips TBA mapping when tba_address is null', async () => {
    const resolver = makeResolver()
    const event = { ...baseEvent, tba_address: null }
    // No existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT agent_entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_test456' }] })
    // INSERT wallet_mapping for owner only
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT identity_link
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    // Only 4 queries: check existing, insert entity, insert owner mapping, insert link
    expect(mockDb.query).toHaveBeenCalledTimes(4)
  })

  it('updates reputation for ReputationUpdated', async () => {
    const resolver = makeResolver()
    const event: ERC8004Event = {
      ...baseEvent,
      event_type: 'reputation_updated',
      reputation_score: 8500,
      validator_address: '0xValidator',
      evidence_hash: '0xEvidence',
    }
    // Find existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    // UPDATE reputation
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE agent_entities'),
      expect.arrayContaining([8500]),
    )
  })

  it('logs warning when ReputationUpdated for unknown agent', async () => {
    const resolver = makeResolver()
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event: ERC8004Event = { ...baseEvent, event_type: 'reputation_updated', reputation_score: 9000 }
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('unknown agent'))
    consoleSpy.mockRestore()
  })

  it('soft-deletes old owner for OwnershipTransferred', async () => {
    const resolver = makeResolver()
    const event: ERC8004Event = {
      ...baseEvent,
      event_type: 'ownership_transferred',
      owner_address: '0xNewOwner',
    }
    const rawData = JSON.parse(event.raw_data)
    event.raw_data = JSON.stringify({ ...rawData, old_owner: '0xOldOwner' })

    // Find existing entity
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ae_existing' }] })
    // Soft-delete old owner mapping
    mockDb.query.mockResolvedValueOnce({ rows: [] })
    // INSERT new owner mapping
    mockDb.query.mockResolvedValueOnce({ rows: [] })

    await resolver.handleERC8004Event(event)

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('removed_at'),
      expect.any(Array),
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/__tests__/identity-resolver.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the identity resolver**

Create `apps/api/src/services/identity-resolver.ts`:

```typescript
import { nanoid } from 'nanoid'
import type { ERC8004Event, WatchlistUpdate } from '@lucid/oracle-core'
import { TOPICS, type RedpandaProducer } from '@lucid/oracle-core'

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export class IdentityResolver {
  constructor(
    private readonly db: DbClient,
    private readonly producer: RedpandaProducer,
  ) {}

  /** Handle an ERC-8004 event from Redpanda */
  async handleERC8004Event(event: ERC8004Event): Promise<void> {
    switch (event.event_type) {
      case 'agent_registered':
        return this.handleAgentRegistered(event)
      case 'agent_updated':
        return this.handleAgentUpdated(event)
      case 'reputation_updated':
        return this.handleReputationUpdated(event)
      case 'ownership_transferred':
        return this.handleOwnershipTransferred(event)
    }
  }

  private async handleAgentRegistered(event: ERC8004Event): Promise<void> {
    // Check for existing entity
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )

    let entityId: string
    if (existing.rows.length > 0) {
      entityId = existing.rows[0].id as string
    } else {
      const id = `ae_${nanoid(12)}`
      await this.db.query(
        'INSERT INTO agent_entities (id, erc8004_id, created_at, updated_at) VALUES ($1, $2, now(), now())',
        [id, event.agent_id],
      )
      entityId = id
    }

    // Upsert TBA mapping (skip if null)
    if (event.tba_address) {
      await this.upsertWalletMapping(entityId, 'base', event.tba_address, 'erc8004_tba', event.tx_hash)
      await this.publishWatchlistUpdate('add', 'base', event.tba_address, entityId)
    }

    // Upsert owner mapping
    await this.upsertWalletMapping(entityId, 'base', event.owner_address, 'erc8004_owner', event.tx_hash)
    await this.publishWatchlistUpdate('add', 'base', event.owner_address, entityId)

    // Create identity link
    await this.db.query(
      `INSERT INTO identity_links (agent_entity, protocol, protocol_id, link_type, confidence, evidence_json)
       VALUES ($1, 'erc8004', $2, 'on_chain_proof', 1.0, $3)
       ON CONFLICT (protocol, protocol_id) DO NOTHING`,
      [entityId, event.agent_id, JSON.stringify({ tx_hash: event.tx_hash, block: event.block_number })],
    )
  }

  private async handleAgentUpdated(event: ERC8004Event): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )
    if (existing.rows.length === 0) {
      console.warn(`[resolver] AgentUpdated for unknown agent: ${event.agent_id}`)
      return
    }
    // Extract display name from raw_data if available
    try {
      const raw = JSON.parse(event.raw_data)
      if (raw.metadataUri || raw.name) {
        await this.db.query(
          'UPDATE agent_entities SET display_name = COALESCE($1, display_name), updated_at = now() WHERE id = $2',
          [raw.name ?? raw.metadataUri, existing.rows[0].id],
        )
      }
    } catch {
      // Skip metadata parse errors
    }
  }

  private async handleReputationUpdated(event: ERC8004Event): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )
    if (existing.rows.length === 0) {
      console.warn(`[resolver] ReputationUpdated for unknown agent: ${event.agent_id}`)
      return
    }
    await this.db.query(
      `UPDATE agent_entities SET reputation_json = $1, reputation_updated_at = now(), updated_at = now() WHERE id = $2`,
      [JSON.stringify({ score: event.reputation_score, validator: event.validator_address, evidence: event.evidence_hash }), existing.rows[0].id],
    )
  }

  private async handleOwnershipTransferred(event: ERC8004Event): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM agent_entities WHERE erc8004_id = $1',
      [event.agent_id],
    )
    if (existing.rows.length === 0) {
      console.warn(`[resolver] OwnershipTransferred for unknown agent: ${event.agent_id}`)
      return
    }
    const entityId = existing.rows[0].id as string

    // Extract old owner from raw_data
    let oldOwner: string | null = null
    try {
      const raw = JSON.parse(event.raw_data)
      oldOwner = raw.old_owner ?? raw.previousOwner ?? null
    } catch { /* skip */ }

    // Soft-delete old owner mapping
    if (oldOwner) {
      await this.db.query(
        `UPDATE wallet_mappings SET removed_at = now() WHERE chain = 'base' AND LOWER(address) = LOWER($1) AND removed_at IS NULL`,
        [oldOwner],
      )
      await this.publishWatchlistUpdate('remove', 'base', oldOwner, entityId)
    }

    // Add new owner mapping
    await this.upsertWalletMapping(entityId, 'base', event.owner_address, 'erc8004_owner', event.tx_hash)
    await this.publishWatchlistUpdate('add', 'base', event.owner_address, entityId)
  }

  private async upsertWalletMapping(
    entityId: string,
    chain: string,
    address: string,
    linkType: string,
    txHash: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO wallet_mappings (agent_entity, chain, address, link_type, confidence, evidence_hash)
       VALUES ($1, $2, $3, $4, 1.0, $5)
       ON CONFLICT (chain, address) WHERE removed_at IS NULL DO UPDATE SET
         agent_entity = EXCLUDED.agent_entity,
         link_type = EXCLUDED.link_type,
         evidence_hash = EXCLUDED.evidence_hash`,
      [entityId, chain, address, linkType, txHash],
    )
  }

  private async publishWatchlistUpdate(
    action: 'add' | 'remove',
    chain: 'base' | 'solana',
    address: string,
    entityId: string,
  ): Promise<void> {
    const update: WatchlistUpdate = { action, chain, address, agent_entity_id: entityId }
    await this.producer.publishJson(TOPICS.WATCHLIST, `${chain}:${address}`, update)
  }
}
```

- [ ] **Step 4: Update apps/api/package.json**

Add `nanoid` dependency:

```json
{
  "dependencies": {
    "@lucid/oracle-core": "*",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "pino": "^9.0.0",
    "nanoid": "^5.0.0"
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: All pass including 5 new resolver tests

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/identity-resolver.ts apps/api/src/__tests__/identity-resolver.test.ts apps/api/package.json
git commit -m "feat: add identity resolver — ERC-8004 event consumer with deterministic linking"
```

---

### Task 9: Wallet Watchlist Manager

**Files:**
- Create: `apps/api/src/services/wallet-watchlist.ts`
- Create: `apps/api/src/__tests__/wallet-watchlist.test.ts`

- [ ] **Step 1: Write the watchlist manager tests**

Create `apps/api/src/__tests__/wallet-watchlist.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletWatchlist } from '../services/wallet-watchlist.js'

const mockDb = {
  query: vi.fn(),
}

describe('WalletWatchlist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads Solana wallets from DB', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { address: 'SolWallet1' },
        { address: 'SolWallet2' },
      ],
    })
    const wl = new WalletWatchlist(mockDb as any)
    await wl.loadSolanaWallets()
    expect(wl.getSolanaWallets()).toEqual(new Set(['SolWallet1', 'SolWallet2']))
  })

  it('adds wallet to watchlist', () => {
    const wl = new WalletWatchlist(mockDb as any)
    wl.handleWatchlistUpdate({ action: 'add', chain: 'solana', address: 'NewWallet', agent_entity_id: 'ae_1' })
    expect(wl.getSolanaWallets().has('NewWallet')).toBe(true)
  })

  it('removes wallet from watchlist', () => {
    const wl = new WalletWatchlist(mockDb as any)
    wl.handleWatchlistUpdate({ action: 'add', chain: 'solana', address: 'W1', agent_entity_id: 'ae_1' })
    wl.handleWatchlistUpdate({ action: 'remove', chain: 'solana', address: 'W1', agent_entity_id: 'ae_1' })
    expect(wl.getSolanaWallets().has('W1')).toBe(false)
  })

  it('tracks Base wallets separately from Solana', () => {
    const wl = new WalletWatchlist(mockDb as any)
    wl.handleWatchlistUpdate({ action: 'add', chain: 'base', address: '0xBase1', agent_entity_id: 'ae_1' })
    wl.handleWatchlistUpdate({ action: 'add', chain: 'solana', address: 'Sol1', agent_entity_id: 'ae_2' })
    expect(wl.getSolanaWallets().has('0xBase1')).toBe(false)
    expect(wl.getSolanaWallets().has('Sol1')).toBe(true)
  })
})
```

- [ ] **Step 2: Write the watchlist manager**

Create `apps/api/src/services/wallet-watchlist.ts`:

```typescript
import type { WatchlistUpdate } from '@lucid/oracle-core'

interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export class WalletWatchlist {
  private readonly solanaWallets = new Set<string>()
  private readonly baseWallets = new Set<string>()

  constructor(private readonly db: DbClient) {}

  /** Load Solana watched wallets from Postgres */
  async loadSolanaWallets(): Promise<void> {
    const result = await this.db.query(
      `SELECT address FROM wallet_mappings WHERE chain = 'solana' AND removed_at IS NULL`,
    )
    this.solanaWallets.clear()
    for (const row of result.rows) {
      this.solanaWallets.add(row.address as string)
    }
  }

  /** Load Base watched wallets from Postgres */
  async loadBaseWallets(): Promise<void> {
    const result = await this.db.query(
      `SELECT address FROM wallet_mappings WHERE chain = 'base' AND removed_at IS NULL`,
    )
    this.baseWallets.clear()
    for (const row of result.rows) {
      this.baseWallets.add(row.address as string)
    }
  }

  /** Handle a watchlist update event from Redpanda */
  handleWatchlistUpdate(update: WatchlistUpdate): void {
    const set = update.chain === 'solana' ? this.solanaWallets : this.baseWallets
    if (update.action === 'add') {
      set.add(update.address)
    } else {
      set.delete(update.address)
    }
  }

  getSolanaWallets(): Set<string> {
    return this.solanaWallets
  }

  getBaseWallets(): Set<string> {
    return this.baseWallets
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run`
Expected: All pass including 4 new watchlist tests

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/wallet-watchlist.ts apps/api/src/__tests__/wallet-watchlist.test.ts
git commit -m "feat: add wallet watchlist manager — tracks Solana + Base watched addresses"
```

---

### Task 10: Wire Resolver + Webhook into API Server

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add resolver and webhook integration**

In `apps/api/src/server.ts`, add after the existing Redpanda consumer setup:

```typescript
import { IdentityResolver } from './services/identity-resolver.js'
import { WalletWatchlist } from './services/wallet-watchlist.js'
import { registerHeliusWebhook } from './routes/helius-webhook.js'
import { TOPICS, type ERC8004Event, type WatchlistUpdate, RedpandaConsumer } from '@lucid/oracle-core'
```

After the existing `reconcileFeedCache` call, add:

```typescript
  // Plan 4A: Identity resolver + Helius webhook
  const databaseUrl = process.env.DATABASE_URL
  const heliusSecret = process.env.HELIUS_WEBHOOK_SECRET

  if (databaseUrl) {
    const { default: pg } = await import('pg')
    const pgClient = new pg.Client({ connectionString: databaseUrl })
    await pgClient.connect()

    const resolverProducer = new (await import('@lucid/oracle-core')).RedpandaProducer({
      brokers: redpandaBrokers!.split(','),
      clientId: 'oracle-api-resolver',
    })
    await resolverProducer.connect()

    const resolver = new IdentityResolver(pgClient, resolverProducer)
    const watchlist = new WalletWatchlist(pgClient)
    await watchlist.loadSolanaWallets()
    app.log.info(`Watchlist loaded: ${watchlist.getSolanaWallets().size} Solana wallets`)

    // Start ERC-8004 consumer for resolver
    const resolverConsumer = new RedpandaConsumer({
      brokers: redpandaBrokers!.split(','),
      groupId: 'oracle-api-resolver',
    })
    await resolverConsumer.subscribe([TOPICS.RAW_ERC8004])
    resolverConsumer.runRaw(async (_key, value) => {
      if (!value) return
      const event = JSON.parse(value) as ERC8004Event
      await resolver.handleERC8004Event(event)
    }).catch((err) => {
      app.log.error('ERC-8004 resolver consumer error:', err)
    })

    // Start watchlist consumer
    const watchlistConsumer = new RedpandaConsumer({
      brokers: redpandaBrokers!.split(','),
      groupId: 'oracle-api-watchlist',
    })
    await watchlistConsumer.subscribe([TOPICS.WATCHLIST])
    watchlistConsumer.runRaw(async (_key, value) => {
      if (!value) return
      const update = JSON.parse(value) as WatchlistUpdate
      watchlist.handleWatchlistUpdate(update)
    }).catch((err) => {
      app.log.error('Watchlist consumer error:', err)
    })

    // Register Helius webhook if secret is configured
    if (heliusSecret) {
      registerHeliusWebhook(app, resolverProducer, watchlist.getSolanaWallets(), heliusSecret)
      app.log.info('Helius webhook endpoint registered')
    }

    // Lifecycle: graceful shutdown for Plan 4A services.
    // On SIGTERM/close, disconnect consumers first (stop processing),
    // then producer (flush pending), then Postgres.
    app.addHook('onClose', async () => {
      app.log.info('Shutting down Plan 4A services...')
      await resolverConsumer.disconnect().catch(() => {})
      await watchlistConsumer.disconnect().catch(() => {})
      await resolverProducer.disconnect().catch(() => {})
      await pgClient.end().catch(() => {})
      app.log.info('Plan 4A services shut down')
    })

    app.log.info('Identity resolver started')
  }
```

> **Lifecycle note:** All Plan 4A resources (2 consumers, 1 producer, 1 pg client) are torn down via Fastify's `onClose` hook, which fires on `app.close()` and SIGTERM. Disconnect order: consumers → producer → pg. The `.catch(() => {})` guards prevent cascading errors during shutdown. When the resolver is extracted to its own service (post-Plan 4A), this moves to a standalone process manager.

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: All tests still pass (server.ts is not imported by tests)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat: wire identity resolver + Helius webhook into API server"
```

---

## Chunk 4: Finalization

### Task 11: Dockerfile — Ponder Target

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add ponder package and target**

In `Dockerfile`, after the publisher COPY line:
```dockerfile
COPY apps/ponder/package.json apps/ponder/
```

And after the publisher target:
```dockerfile
# Ponder target (Base indexer)
FROM base AS ponder
CMD ["npx", "ponder", "start"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add ponder target to Dockerfile"
```

---

### Task 12: Install Dependencies + Run Full Test Suite

- [ ] **Step 1: Install nanoid**

Run: `npm install`

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (88 existing + ~19 new = ~107 tests)

- [ ] **Step 3: Commit lock file if changed**

```bash
git add package-lock.json
git commit -m "chore: update lockfile after nanoid install"
```

---

## Convention Notes

- **EventSource `erc8004`**: Replaces `erc8004_eth` from the parent spec. Chain is tracked in the separate `chain` field (`'base'`). Nothing uses the old value.
- **`computeEventId()`**: Used consistently across all adapters for deterministic, UUID-formatted event IDs.
- **`protocol: 'independent'`**: Permanent value for wallet activity not attributed to a specific protocol.
- **Producer methods**: `publishEvents()` for `RawEconomicEvent[]` batches (wallet activity), `publishJson()` for generic JSON messages (watchlist updates). Both on `RedpandaProducer`.
- **Ponder**: Runs as adapter-only. Uses broad token contract indexing + in-memory watchlist filter, not per-address contract filters (Ponder limitation). Watchlist refreshed via KafkaJS consumer on `wallet_watchlist.updated` → full reload from Postgres.
- **Resolver in API process**: Plan 4A simplification. All resources cleaned up via Fastify `onClose` hook. Extract to own service when API scales horizontally.
- **All timestamps**: ISO 8601 strings in events, `Date` objects in TypeScript interfaces.
- **Confidence**: Always 1.0 in Plan 4A. Schema supports <1.0 for future heuristic strategies.
