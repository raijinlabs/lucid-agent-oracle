# Plan 4A: External Adapters + Identity Resolution — Design Specification

**Date:** 2026-03-12
**Status:** Frozen for implementation planning
**Authors:** RaijinLabs + Claude
**Parent spec:** `docs/specs/2026-03-12-agent-economy-oracle-design.md`
**Depends on:** Plans 1, 2A, 2B (all completed)
**Unlocks:** Plan 3A (API expansion with Agents as first-class noun)

---

## 1. Goal

Build the identity and economic substrates that make **Agents** a real, cross-protocol API noun — not a placeholder backed by Lucid-only data.

Plan 4A adds:
- **ERC-8004 indexer** on Base for agent identity and reputation
- **Wallet activity indexer** on Base (Ponder) and Solana (Helius) for cross-chain economic data
- **Deterministic identity resolver** linking wallets → agent entities via on-chain proof and Lucid passport

**Design principle:** High precision, lower recall. Only create agent identity links that can be defended with on-chain proof or authenticated Lucid data. No heuristic matching, no behavioral inference, no self-registration in this plan.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    IDENTITY SUBSTRATE                        │
│  Ponder (Base) ──→ raw.erc8004.events ──→ Redpanda          │
│    • Identity Registry  (0x8004A169FB4a3325136EB29fA0ceB6D2e539a432) │
│    • Reputation Registry (0x8004BAa17C55a88189AE136b182e5fdA19dE9b63) │
├─────────────────────────────────────────────────────────────┤
│                    ECONOMIC SUBSTRATE                        │
│  Ponder (Base) ──→ raw.agent_wallets.events ──→ Redpanda     │
│  Helius (Solana) ──→ raw.agent_wallets.events ──→ Redpanda   │
│    • Webhooks (live) + Enhanced Transactions API (backfill)   │
├─────────────────────────────────────────────────────────────┤
│                   IDENTITY RESOLVER                          │
│  Consumes: raw.erc8004.events + Lucid gateway data           │
│  Writes: agent_entities, wallet_mappings, identity_links     │
│  Emits: wallet_watchlist.updated (Redpanda)                  │
│  Strategy: deterministic only                                │
├─────────────────────────────────────────────────────────────┤
│                   EXISTING DATA PLANE                        │
│  raw_economic_events ──→ metric_rollups ──→ published_feeds   │
│  (Plans 1/2A — unchanged)                                    │
└─────────────────────────────────────────────────────────────┘
```

### Architecture Rules

1. **Ponder is adapter-only.** It normalizes Base events and publishes to Redpanda. No direct Postgres writes. No analytical queries against Ponder's internal store.
2. **Identity and economic events use separate Redpanda topics.** `raw.erc8004.events` for identity, `raw.agent_wallets.events` for wallet activity. Same backbone, distinct streams.
3. **Resolver runs inside the API process** as a Redpanda consumer (Plan 4A simplification). Becomes its own service when API scales horizontally.
4. **Deterministic linking only.** Every `wallet_mapping` and `identity_link` must cite a verifiable proof source. Confidence is always 1.0 in Plan 4A.

---

## 3. ERC-8004 Indexer (Ponder)

### Target Contracts (Base Mainnet)

| Contract | Address | Events |
|----------|---------|--------|
| Identity Registry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `AgentRegistered`, `AgentUpdated`, `OwnershipTransferred` |
| Reputation Registry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `ReputationUpdated` |

> **Note:** `ValidationRecorded` events from the Validation Registry are deferred — the standard is under active development. Plan 4A indexes Identity + Reputation only.

### Event Normalization

ERC-8004 events are normalized into a typed envelope before publishing to `raw.erc8004.events`:

```typescript
interface ERC8004Event {
  event_id: string            // deterministic UUID v5 from namespace + (source, chain, tx_hash, log_index)
                              // matches parent spec's raw_economic_events.event_id UUID format
  event_type: 'agent_registered' | 'agent_updated' | 'ownership_transferred'
             | 'reputation_updated'
  source: 'erc8004'
  chain: 'base'
  block_number: number
  tx_hash: string
  log_index: number
  timestamp: Date

  // Identity fields
  agent_id: string            // ERC-8004 agentId (hex)
  owner_address: string       // checksummed
  tba_address: string | null  // Token-Bound Account if applicable (null for non-TBA agents)

  // Reputation fields (for reputation_updated events only)
  reputation_score: number | null
  validator_address: string | null
  evidence_hash: string | null

  // Raw
  raw_data: string            // JSON-encoded full event data
}
```

**`event_id` derivation:** Use UUID v5 with a fixed namespace UUID and the natural key `(source, chain, tx_hash, log_index)` as the name. This produces a deterministic UUID compatible with the parent spec's `raw_economic_events.event_id UUID` column.

---

## 4. Wallet Activity Indexer

### 4.1 Base — Ponder Wallet Handler

Indexes economic activity for known agent wallets on Base:
- ERC-20 transfers (USDC, USDT, WETH, and other tracked tokens)
- Native ETH transfers
- DEX swap events (Uniswap V3, Aerodrome)

Normalizes into `raw_economic_events` format and publishes to `raw.agent_wallets.events`.

**Watchlist filtering strategy:**

Ponder's contract/event filters are declared at startup in `ponder.config.ts` and cannot be dynamically modified at runtime. The wallet handler therefore uses a **broad index + application-layer filter** approach:

1. Ponder indexes all ERC-20 Transfer events for tracked token contracts (USDC, USDT, WETH) — not per-wallet, per-token-contract
2. The `wallet-activity.ts` handler maintains an in-memory `Set<string>` of watched addresses, loaded from `wallet_mappings` on startup
3. On each Transfer event, the handler checks if `from` or `to` is in the watched set — if not, the event is discarded silently
4. When the resolver publishes `wallet_watchlist.updated`, the handler refreshes its in-memory set from Postgres — no Ponder restart needed

**Cost/performance note:** This means Ponder processes all Transfer events on tracked token contracts, not just agent wallets. For USDC/USDT on Base, this is high volume. Mitigation: the filter check is O(1) Set lookup, and discarded events never reach Redpanda. If volume becomes problematic, the token contract list can be narrowed or event processing batched.

### 4.2 Solana — Helius

**Live ingestion — Webhooks:**
- Webhook endpoint: `POST /v1/internal/helius/webhook` in the oracle API
- **Authentication:** Verifies Helius HMAC-SHA256 signature using `HELIUS_WEBHOOK_SECRET` env var. Returns 401 on signature mismatch. Follows the same pattern as LucidMerged's launchpad Helius integration.
- Monitors known Solana agent wallets from `wallet_mappings WHERE chain = 'solana' AND removed_at IS NULL`
- Helius Enhanced Transaction format → normalized `raw_economic_events` → `raw.agent_wallets.events`
- Idempotent via deterministic `event_id` from `(source, chain, tx_hash, instruction_index)`
- Helius may retry deliveries and produce duplicates — handled by existing idempotent ingestion

**Backfill — Enhanced Transactions API:**
- Used on startup and when new Solana wallets are added to watchlist
- Fetches historical transactions for each known wallet
- Same normalization pipeline as webhooks → same Redpanda topic
- Rate-limited background job, not blocking

**Watchlist updates:**
- Resolver publishes `wallet_watchlist.updated` event
- Helius watchlist manager consumes event, calls Helius API to add/remove addresses from webhook

### 4.3 Wallet Activity Event Format

Wallet activity events reuse the existing `raw_economic_events` schema with these field conventions:

| Field | Wallet Activity Value |
|-------|----------------------|
| `source` | `'helius'` or `'ponder'` |
| `chain` | `'solana'` or `'base'` |
| `event_type` | `'transfer'`, `'swap'`, `'contract_interaction'` |
| `subject_raw_id` | wallet address |
| `counterparty_raw_id` | destination/counterparty address |
| `protocol` | `'independent'` — permanent value for wallet activity not attributed to a specific protocol. AEGDP correctly includes the `independent` slice in its aggregate sum. |
| `amount` | transfer amount in native units |
| `currency` | token symbol |
| `usd_value` | USD equivalent at time of transaction |
| `economic_authentic` | `true` (on-chain = authentic by definition) |

---

## 5. Control Plane Tables (Postgres/Supabase)

### 5.1 agent_entities

```sql
CREATE TABLE agent_entities (
  id                    TEXT PRIMARY KEY,        -- 'ae_' + nanoid
  display_name          TEXT,
  erc8004_id            TEXT UNIQUE,             -- ERC-8004 agentId (hex)
  lucid_tenant          TEXT,                    -- gateway_tenants.id if Lucid-native
  reputation_json       JSONB,                   -- latest ERC-8004 reputation snapshot
  reputation_updated_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_entities_erc8004 ON agent_entities(erc8004_id) WHERE erc8004_id IS NOT NULL;
CREATE INDEX idx_agent_entities_lucid ON agent_entities(lucid_tenant) WHERE lucid_tenant IS NOT NULL;
```

### 5.2 wallet_mappings

```sql
CREATE TABLE wallet_mappings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity  TEXT NOT NULL REFERENCES agent_entities(id),
  chain         TEXT NOT NULL,           -- 'base' | 'solana' | 'ethereum'
  address       TEXT NOT NULL,           -- checksummed (EVM) or base58 (Solana)
  link_type     TEXT NOT NULL,           -- 'erc8004_tba' | 'erc8004_owner' | 'lucid_passport'
  confidence    REAL DEFAULT 1.0,        -- 1.0 for deterministic (Plan 4A), <1.0 for heuristic (future)
  evidence_hash TEXT,                    -- SHA-256 of proof
  created_at    TIMESTAMPTZ DEFAULT now(),
  removed_at    TIMESTAMPTZ,             -- soft-delete for ownership transfers (NULL = active)
  UNIQUE (chain, address)               -- one wallet → one agent entity (active only)
);

CREATE INDEX idx_wallet_mappings_entity ON wallet_mappings(agent_entity);
```

### 5.3 identity_links

```sql
CREATE TABLE identity_links (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity    TEXT NOT NULL REFERENCES agent_entities(id),
  protocol        TEXT NOT NULL,          -- 'erc8004' | 'lucid'
  protocol_id     TEXT NOT NULL,          -- protocol-specific identifier
  link_type       TEXT NOT NULL,          -- 'on_chain_proof' | 'gateway_correlation'
  confidence      REAL DEFAULT 1.0,
  evidence_json   TEXT,                   -- JSON proof blob
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (protocol, protocol_id)         -- one protocol ID → one agent entity
);

CREATE INDEX idx_identity_links_entity ON identity_links(agent_entity);
```

### Design Notes

- `confidence` is always 1.0 in Plan 4A. Column exists for Plan 4B heuristic strategies without schema migration.
- `link_type` values are extensible strings, not enums — future strategies add new types without ALTER.
- `UNIQUE (chain, address)` enforces one-wallet-one-agent — deterministic resolver cannot produce multi-match.
- `removed_at` on `wallet_mappings` enables soft-delete for ownership transfers while preserving the audit trail.
- `evidence_hash` / `evidence_json` provide audit trail for every link.
- **`identity_evidence` table** (referenced in parent spec §4.5) is deferred to Plan 4B. Plan 4A stores evidence inline in `identity_links.evidence_json`. Evidence volumes in deterministic-only mode are low enough for inline storage.

---

## 6. Identity Resolver

### 6.1 Overview

Event-driven consumer running inside the API process (Plan 4A simplification). Consumes `raw.erc8004.events` from Redpanda and Lucid gateway data from Postgres.

### 6.2 ERC-8004 Resolution Flow

Triggered by: new event on `raw.erc8004.events`

1. **`AgentRegistered`** event:
   - Extract `agentId`, `owner`, `tba_address` from event
   - Check if `agent_entities` row exists for this `erc8004_id`
   - If not: create new `agent_entity` with `id = 'ae_' + nanoid()`, `erc8004_id = agentId`
   - If `tba_address` is not null: upsert `wallet_mappings` for TBA address (`chain: 'base'`, `link_type: 'erc8004_tba'`). If `tba_address` is null, skip TBA mapping.
   - Upsert `wallet_mappings` for owner address (`chain: 'base'`, `link_type: 'erc8004_owner'`)
   - Create `identity_links` row (`protocol: 'erc8004'`, `link_type: 'on_chain_proof'`)
   - Publish `wallet_watchlist.updated` to Redpanda with new Base addresses

2. **`AgentUpdated`** event:
   - Look up `agent_entity` by `erc8004_id`
   - If found: update `display_name` if metadata contains a name field; update `updated_at`
   - If agent not found: log warning, skip
   - No wallet changes — `AgentUpdated` reflects metadata updates, not ownership

3. **`ReputationUpdated`** event:
   - Look up `agent_entity` by `erc8004_id`
   - Update `reputation_json` and `reputation_updated_at`
   - If agent not found: log warning, skip (reputation without identity registration is unexpected)

4. **`OwnershipTransferred`** event:
   - Soft-delete old owner's `wallet_mappings` row: set `removed_at = now()` (preserves audit trail)
   - Add new `wallet_mappings` for new owner address (`link_type: 'erc8004_owner'`)
   - Publish `wallet_watchlist.updated` with both `remove` (old) and `add` (new) actions

### 6.3 Lucid-Native Resolution

Runs on API startup (batch) and can be re-triggered manually:

1. Query `gateway_tenants` for tenants with wallet addresses stored in `payment_config` JSONB column (path: `payment_config->'wallets'`, an array of `{chain, address}` objects). Tenants without `payment_config` or without a `wallets` array are skipped.
2. For each tenant:
   - Create `agent_entity` with `lucid_tenant = tenant.id`
   - Add `wallet_mappings` for each known wallet (`link_type: 'lucid_passport'`, `confidence: 1.0`)
   - If wallet address matches an existing ERC-8004 agent entity → merge (link `lucid_tenant` to same entity)
3. Create `identity_links` row (`protocol: 'lucid'`, `link_type: 'gateway_correlation'`)
4. Publish `wallet_watchlist.updated` for any Solana wallets discovered

### 6.4 Solana Wallet Linking

Solana wallets are linked to agent entities only when:
- A Lucid passport explicitly stores a Solana wallet address, OR
- A signed ownership proof is submitted (future, not Plan 4A)

**No inference from bridge activity.** Cross-chain bridge transactions are not treated as identity proof.

### 6.5 Merge Semantics

When two identity sources point to the same wallet:
- If wallet already belongs to an agent entity → the new source enriches that entity (add identity_link, update metadata)
- Two different agent entities claiming the same wallet is a conflict → log error, keep existing mapping, flag for manual review

Plan 4A does not implement automated entity merging. Conflicts are logged and left for operator resolution.

---

## 7. Watchlist Update Protocol

```
Resolver detects new wallet
    ↓
Upserts wallet_mappings (Postgres)
    ↓
Publishes wallet_watchlist.updated (Redpanda)
    ├──→ Ponder wallet handler: refreshes in-memory watched addresses from Postgres
    └──→ Helius watchlist manager: calls Helius API to add address to webhook
```

**Topic configuration for `wallet_watchlist.updated`:**
- Partitions: 1 (ordering matters — add before remove)
- Retention: 1 day
- Consumer groups: each consumer (Ponder wallet handler, Helius watchlist manager) uses a distinct group ID so both receive all events

The `wallet_watchlist.updated` event payload:

```typescript
interface WatchlistUpdate {
  action: 'add' | 'remove'
  chain: 'base' | 'solana'
  address: string
  agent_entity_id: string
}
```

---

## 8. Feed Computation Impact

**AEGDP** can incorporate cross-protocol wallet activity immediately. USD-denominated transfers from Base and Solana wallets normalize cleanly into the existing `sum(usd_value)` computation.

**AAI and APRI** may require methodology v2 filters/weights once non-Lucid wallet activity is flowing. Current dimensions (`tool_call`, `llm_inference`, `provider`, `model_id`, `economic_authentic`, activity continuity) are Lucid-native semantics that do not map directly to raw wallet transfers and swaps. Plan 4A does not change feed computation formulas — it provides the data substrate. Feed methodology updates are a separate, deliberate change.

---

## 9. Spec-Sync Edits (Parent Design Doc)

The following updates to the parent design spec are required to align with Plan 4A decisions:

1. **Source-adapter table**: ERC-8004 target is Base-first, not Ethereum-first. Update the source row from `ERC-8004 → Ethereum` to `ERC-8004 → Base`.

2. **Redpanda topic table**: `raw.agent_wallets.events` can be produced by both Helius (Solana) and Ponder (Base/EVM), not only "Helius/Alchemy webhook handlers."

3. **Feed methodology note**: Add a note to the feed definitions section stating that AAI/APRI methodology v2 will be required when cross-protocol economic data begins flowing.

4. **Redpanda topic table**: Add `wallet_watchlist.updated` (1 partition, 1 day retention, consumers: identity-resolver, wallet-watchlist service).

---

## 10. New Files

```
apps/ponder/
  package.json
  ponder.config.ts              — Base RPC, contract ABIs, start blocks
  ponder.schema.ts              — Ponder table definitions
  src/erc8004-identity.ts       — Identity Registry indexing handler
  src/erc8004-reputation.ts     — Reputation Registry indexing handler
  src/wallet-activity.ts        — Agent wallet transfers/swaps handler
  src/redpanda-sink.ts          — Shared Redpanda producer for all handlers

packages/core/src/adapters/
  helius.ts                     — Helius webhook normalizer + backfill client
  erc8004.ts                    — ERC-8004 event type definitions + normalization

apps/api/src/routes/
  helius-webhook.ts             — POST /v1/internal/helius/webhook

apps/api/src/services/
  identity-resolver.ts          — Event-driven resolver (Redpanda consumer)
  wallet-watchlist.ts           — Helius + Ponder watchlist management

migrations/supabase/
  YYYYMMDD_agent_identity.sql   — agent_entities, wallet_mappings, identity_links tables
```

---

## 11. What Plan 4A Does NOT Include

| Deferred Item | Target Plan |
|---------------|-------------|
| Heuristic identity linking (behavioral wallet clustering) | Plan 4B |
| Self-registration endpoint (`POST /agents/register`) | Plan 4B |
| Virtuals-specific enrichment adapter | Plan 4C |
| Generic ERC-8004 registry discovery | Plan 4C |
| Validation Registry indexing | Deferred (standard evolving) |
| API expansion (`/agents/*` endpoints) | Plan 3A |
| Dashboard | Plan 3C |
| Automated entity merge/split | Plan 4B |
| Feed methodology v2 (AAI/APRI cross-protocol weights) | Separate plan |

---

## 12. Success Criteria

Plan 4A is complete when:
1. ERC-8004 Identity + Reputation events are indexed from Base into `raw.erc8004.events`
2. Known agent wallet activity is indexed from Base (Ponder) and Solana (Helius) into `raw.agent_wallets.events`
3. `agent_entities` table contains canonical agent records with ERC-8004 and Lucid-native sources
4. `wallet_mappings` table links wallets to agents with verifiable proof
5. Helius webhook watchlist updates automatically when new Solana wallets are discovered
6. All identity links have `confidence = 1.0` (deterministic only)
7. Cross-protocol wallet activity flows into `raw_economic_events` in ClickHouse
8. Existing 88 TypeScript tests still pass
