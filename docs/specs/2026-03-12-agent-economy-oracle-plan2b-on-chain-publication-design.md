# Agent Economy Oracle — Plan 2B: On-Chain Publication

**Scope:** Solana Anchor program, Base Foundry contract, unified chain publisher service, worker integration for typed publication messages. No consumer SDKs, no CPI helpers, no historical on-chain storage, no The Graph, no Redis.

**Builds on:** Plan 2A (Feed Worker Pipeline) — worker computes + attests AEGDP/AAI/APRI, persists to ClickHouse `published_feed_values`, fanout via Redpanda `INDEX_UPDATES`.

**Product identity:** AI/agent-first product, DeFi-compatible publication layer. On-chain contracts are **publication-only** — they receive signed reports and make them readable. No business logic in smart contracts. DeFi is a powerful distribution channel, not the product identity. The moat is gateway-layer AI agent data (requests, payments, tool calls, sessions, model/provider usage).

**Global spec deviations (intentional):**
- **Base: per-feed `postReport`** — The global spec describes an MVR (multi-value report) bundled pattern. Plan 2B deliberately uses per-feed `postReport(feedId, ...)` instead. This avoids coordinating 3 feed computations into a single transaction when they may complete at different times. The MVR bundle can be added as a convenience method in v2 without breaking the per-feed interface. **This is a documented deviation, not an oversight.**
- **Solana: no CPI helper** — The global spec includes `verify_and_read`. Plan 2B defers this to Plan 3. Consumers read PDA accounts directly using standard Anchor deserialization. Adding CPI later is additive.
- **Solana: latest-only** — `FeedReport` PDA uses `[b"report", feed_id]` (no timestamp key). Only the latest report is stored per feed. Historical reports live in ClickHouse. This keeps rent costs flat regardless of publication frequency.
- **ClickHouse publication status**: Uses a separate `pub_status_rev` column for publication-status tracking (insert new row with higher `pub_status_rev`) instead of `ALTER TABLE UPDATE`. The existing `revision` column is reserved for computation restatements only. This preserves ReplacingMergeTree semantics and avoids ClickHouse mutations while keeping the two concerns cleanly separated.
- **Worker → publisher message**: Worker publishes a typed `PublicationRequest` to `publication.requests` topic, not a raw `PublishedFeedRow`. This decouples the publisher service from storage schema.

---

## 1. Architecture Overview

Three deliverables:

```
┌──────────────────────────────────────────────────────────────┐
│  apps/worker                                                  │
│  ─────────                                                    │
│  Computes feed values → attests → persists to ClickHouse      │
│  → publishes PublicationRequest to TOPICS.PUBLICATION          │
└──────────────────┬───────────────────────────────────────────┘
                   │ Redpanda: publication.requests
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  apps/publisher (NEW)                                         │
│  ───────────────                                              │
│  Consumes PublicationRequest → posts to both chains in        │
│  parallel → updates ClickHouse with tx hashes via             │
│  revision-row replacement                                     │
└───────┬──────────────────────────────────────┬───────────────┘
        │                                      │
        ▼                                      ▼
┌──────────────────┐               ┌──────────────────────────┐
│  Solana Program   │               │  Base Contract            │
│  (Anchor)         │               │  (Foundry)                │
│  ──────────       │               │  ──────────               │
│  FeedConfig PDA   │               │  LucidOracle.sol          │
│  FeedReport PDA   │               │  ─────────────            │
│  3 instructions   │               │  postReport()             │
│  Ed25519 verify   │               │  getLatestReport()        │
└──────────────────┘               │  rotateAuthority()        │
                                   └──────────────────────────┘
```

**Data flow:** Worker computes → attests → persists → publishes `PublicationRequest` → publisher consumes → posts to Solana + Base in parallel → inserts revision-row with tx hashes into `published_feed_values`.

### On-Chain Value Encoding

| Feed | `value` encoding | `decimals` | Example |
|------|-----------------|-----------|---------|
| AEGDP | USD × 10^6 | 6 | $847,000 → `847000000000` |
| AAI | index score (0–1000) | 0 | 742 → `742` |
| APRI | basis points (0–10000) | 0 | 3200 → `3200` |

The publisher reads `value_usd` (AEGDP) or `value_index` (AAI/APRI) from the `PublicationRequest` and applies the feed-specific scaling before posting on-chain.

---

## 2. Solana Anchor Program (Slim)

**Package:** `contracts/solana/` (Anchor workspace)

**Program ID:** Deployed to devnet first, mainnet after testing.

### Account Structure

**FeedConfig PDA** — `seeds = [b"feed", feed_id.as_bytes()]`

```rust
#[account]
pub struct FeedConfig {
    pub feed_id: [u8; 16],         // e.g., "aegdp\0..."
    pub feed_version: u16,
    pub authority: Pubkey,          // Lucid signer (upgradable to multisig)
    pub min_signers: u8,            // 1 at launch
    pub signer_set: Vec<Pubkey>,    // authorized Ed25519 signers
    pub update_cadence: u32,        // expected seconds between updates
    pub bump: u8,
}
```

**FeedReport PDA** — `seeds = [b"report", feed_id.as_bytes()]`

Latest-only. One report per feed, overwritten on each `post_report`.

```rust
#[account]
pub struct FeedReport {
    pub feed_id: [u8; 16],
    pub feed_version: u16,
    pub report_timestamp: i64,      // Unix timestamp ms
    pub value: u64,                 // scaled by decimals
    pub decimals: u8,
    pub confidence: u16,            // basis points (9700 = 0.97)
    pub revision: u16,
    pub input_manifest_hash: [u8; 32],
    pub computation_hash: [u8; 32],
    pub bump: u8,
}
```

### Instructions (3 total)

**1. `initialize_feed`** — Create FeedConfig + FeedReport PDAs. Authority-only. Called once per feed (3 calls total for AEGDP/AAI/APRI).

```rust
pub fn initialize_feed(
    ctx: Context<InitializeFeed>,
    feed_id: [u8; 16],
    feed_version: u16,
    update_cadence: u32,
    signer_set: Vec<Pubkey>,
) -> Result<()>
```

**2. `post_report`** — Write latest report values. Authority-only. Ed25519 signature verified via `Ed25519SigVerify` precompile instruction included in the same transaction. The program inspects `sysvar::instructions` to confirm the Ed25519 verification instruction was present, succeeded, **and matches the expected signer and message**.

```rust
pub fn post_report(
    ctx: Context<PostReport>,
    value: u64,
    decimals: u8,
    confidence: u16,
    revision: u16,
    report_timestamp: i64,
    input_manifest_hash: [u8; 32],
    computation_hash: [u8; 32],
) -> Result<()>
```

Validation:
- Authority matches FeedConfig.authority
- Lexicographic freshness: `(report_timestamp, revision) > (current.report_timestamp, current.revision)` — newer timestamp wins; same timestamp with higher revision wins (supports restatements)
- Ed25519 verify instruction present in transaction (sysvar::instructions check) **with bound verification**:
  - The public key in the Ed25519SigVerify instruction must be in `FeedConfig.signer_set`
  - The message bytes in the Ed25519SigVerify instruction must match the canonical serialization of the report data being posted (the program reconstructs the expected message from the instruction arguments and compares)
  - This prevents replay of unrelated Ed25519 verifications — "some valid signature in this tx" is not enough; it must be **the right signer signing the right report**

**3. `rotate_authority`** — Transfer authority to a new pubkey (e.g., for multisig upgrade). Current authority signs.

```rust
pub fn rotate_authority(
    ctx: Context<RotateAuthority>,
    new_authority: Pubkey,
) -> Result<()>
```

### Ed25519 Verification Pattern

The publisher constructs a transaction with two instructions:
1. `Ed25519SigVerify` precompile instruction (verifies Ed25519 signature against report data)
2. `post_report` instruction (writes values, inspects sysvar::instructions for #1)

This is the standard Solana pattern — Ed25519 precompile is not CPI-callable. However, presence alone is not sufficient. The program must **bind** the verification to the current report by:
1. Reading the Ed25519SigVerify instruction data from `sysvar::instructions`
2. Extracting the public key and verifying it is in `FeedConfig.signer_set`
3. Extracting the message bytes and verifying they match the canonical serialization of the report arguments (`feed_id || report_timestamp || value || decimals || confidence || revision || input_manifest_hash || computation_hash`)

Without this binding, an attacker could include any previously valid Ed25519 verification instruction in the transaction and post arbitrary report data. The message format is a fixed-layout concatenation (not JSON) for deterministic on-chain reconstruction.

### What's NOT in Plan 2B
- No `verify_and_read` CPI helper (consumers read PDAs directly via Anchor deserialization)
- No historical storage (latest-only per feed)
- No consumer SDK crate
- No on-chain governance or voting

---

## 3. Base Foundry Contract (Slim)

**Package:** `contracts/base/` (Foundry project)

**Deployment:** Base Sepolia first, Base mainnet after testing.

### LucidOracle.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract LucidOracle {
    struct Report {
        uint64  reportTimestamp;
        uint64  value;             // scaled by decimals
        uint8   decimals;
        uint16  confidence;        // basis points
        uint16  revision;
        bytes32 inputManifestHash;
        bytes32 computationHash;
    }

    address public authority;
    mapping(bytes16 => Report) public latestReports;

    event ReportPosted(bytes16 indexed feedId, uint64 value, uint64 reportTimestamp, uint16 confidence);
    event AuthorityRotated(address indexed oldAuthority, address indexed newAuthority);

    modifier onlyAuthority() {
        require(msg.sender == authority, "not authority");
        _;
    }

    constructor(address _authority) {
        authority = _authority;
    }

    function postReport(
        bytes16 feedId,
        uint64 value,
        uint8 decimals,
        uint16 confidence,
        uint16 revision,
        uint64 reportTimestamp,
        bytes32 inputManifestHash,
        bytes32 computationHash
    ) external onlyAuthority {
        Report storage current = latestReports[feedId];
        // Lexicographic freshness: newer timestamp wins, or same timestamp with higher revision (restatement)
        require(
            reportTimestamp > current.reportTimestamp ||
            (reportTimestamp == current.reportTimestamp && revision > current.revision),
            "stale report"
        );
        latestReports[feedId] = Report(
            reportTimestamp, value, decimals, confidence, revision,
            inputManifestHash, computationHash
        );
        emit ReportPosted(feedId, value, reportTimestamp, confidence);
    }

    function getLatestReport(bytes16 feedId) external view returns (Report memory) {
        return latestReports[feedId];
    }

    function rotateAuthority(address newAuthority) external onlyAuthority {
        require(newAuthority != address(0), "zero address");
        emit AuthorityRotated(authority, newAuthority);
        authority = newAuthority;
    }
}
```

### Design Notes

- **Per-feed `postReport`** — Deliberate deviation from bundled MVR. Feeds compute at different times; per-feed posting is simpler and avoids coordination overhead. MVR bundle can be added as a convenience method later without breaking the per-feed interface.
- **`ReportPosted` event** — Emitted on every post. Sufficient for off-chain indexing (The Graph adapter if needed later, or direct event log queries). This is the only indexing hook needed.
- **No Ed25519 on-chain verification** — EVM has no native Ed25519 precompile. The authority EOA (ECDSA) gates posting. Ed25519 attestation is the off-chain canonical proof; consumers who need cryptographic verification use the off-chain API. Future: RIP-7212/7696 could enable direct Ed25519 verification.
- **No proxy/upgradability** — Slim contract, no business logic. If the interface needs to change, deploy a new contract and rotate consumers. Avoids proxy complexity for a publication-only surface.

### What's NOT in Plan 2B
- No MVR bundled report method (per-feed is the v1 interface)
- No consumer CPI helpers
- No on-chain fee collection
- No upgradeability proxy

---

## 4. Chain Publisher Service

**Package:** `apps/publisher/` (`@lucid/oracle-publisher`)

Unified TypeScript service that consumes `PublicationRequest` messages from Redpanda `publication.requests` topic and posts to both chains in parallel.

### PublicationRequest Type

Typed message contract between worker and publisher (in `@lucid/oracle-core`):

```typescript
/** Message published to TOPICS.PUBLICATION by the worker */
export interface PublicationRequest {
  /** Feed identifier */
  feed_id: FeedId
  /** Feed schema version */
  feed_version: number
  /** When the value was computed (ISO 8601) */
  computed_at: string
  /** 0 = original, 1+ = restatement */
  revision: number

  // --- Value ---
  /** JSON-encoded feed-specific payload */
  value_json: string
  /** Primary USD value (AEGDP) */
  value_usd: number | null
  /** Primary index value (AAI/APRI) */
  value_index: number | null

  // --- Quality ---
  confidence: number
  completeness: number

  // --- Provenance ---
  input_manifest_hash: string
  computation_hash: string
  methodology_version: number

  // --- Attestation ---
  signer_set_id: string
  signatures_json: string
}
```

This is deliberately **not** `PublishedFeedRow` — it carries exactly what the publisher needs to post on-chain, without storage-layer fields like `published_solana`, `published_base`, `freshness_ms`, `staleness_risk`, `source_coverage`, or `revision_status`.

### Service Architecture

```typescript
// apps/publisher/src/index.ts — entry point
// 1. Load config from env
// 2. Connect to Redpanda, ClickHouse, Solana, Base
// 3. Subscribe to TOPICS.PUBLICATION
// 4. For each message: post to both chains in parallel
// 5. On success: insert revision-row into published_feed_values with tx hashes
// 6. Graceful shutdown on SIGTERM
```

### Config (env vars)

```
# Redpanda
REDPANDA_BROKERS=localhost:9092

# ClickHouse
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=oracle

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR_PATH=~/.config/solana/publisher.json
SOLANA_PROGRAM_ID=<deployed program id>

# Base
BASE_RPC_URL=https://sepolia.base.org
BASE_PRIVATE_KEY=0x...
BASE_CONTRACT_ADDRESS=0x...

# Publisher
PUBLISHER_CONSUMER_GROUP=oracle-publisher
```

### Chain Posting Logic

**Solana posting** (`apps/publisher/src/solana.ts`):

```typescript
async function postToSolana(req: PublicationRequest): Promise<string> {
  // 1. Derive FeedConfig PDA
  // 2. Derive FeedReport PDA
  // 3. Build Ed25519SigVerify instruction from attestation
  // 4. Build post_report instruction
  // 5. Send transaction with both instructions
  // 6. Confirm transaction
  // 7. Return signature (tx hash)
}
```

Uses `@coral-xyz/anchor` + `@solana/web3.js`. Transaction includes the Ed25519 precompile verification instruction followed by the `post_report` instruction.

**Base posting** (`apps/publisher/src/base.ts`):

```typescript
async function postToBase(req: PublicationRequest): Promise<string> {
  // 1. Encode postReport call data
  // 2. Estimate gas
  // 3. Send transaction
  // 4. Wait for receipt
  // 5. Return tx hash
}
```

Uses `viem` (or `ethers` v6). Authority EOA signs the transaction.

### Parallel Posting + Revision-Row Replacement

When a `PublicationRequest` is consumed:

1. Post to Solana and Base **in parallel** (`Promise.allSettled`)
2. After both settle, insert **one status-revision row** into ClickHouse `published_feed_values`:
   - Same `(feed_id, feed_version, computed_at)` as the original row
   - Same `revision` as the original row (computation revision is unchanged)
   - `pub_status_rev = 1` (the original row written by the worker has `pub_status_rev = 0`)
   - `published_solana` = Solana tx signature (or `null` if failed)
   - `published_base` = Base tx hash (or `null` if failed)
   - All other fields copied from the original row
   - ReplacingMergeTree version column is changed from `revision` to `pub_status_rev` — see migration below

One row per publication attempt, not one per chain. If both chains fail, no status-revision row is inserted (original row remains with both fields `null`). If one chain fails, the status-revision row records the successful tx hash and `null` for the failed chain; the next publication cycle posts a fresh value that supersedes it.

**Separation of concerns:** `revision` tracks computation restatements (same timestamp, corrected value). `pub_status_rev` tracks publication metadata updates (same value, new tx hashes). These are orthogonal — a restatement (`revision = 1`) might not yet be published (`pub_status_rev = 0`), and a published value (`pub_status_rev = 1`) might later be restated (`revision = 1, pub_status_rev = 0` for the new computation).

**ClickHouse migration required:** The existing `ReplacingMergeTree(revision)` engine needs to change to `ReplacingMergeTree(pub_status_rev)` with a new `pub_status_rev UInt16 DEFAULT 0` column. Since ClickHouse does not support `ALTER TABLE ... MODIFY ENGINE`, this requires a drop-and-recreate of `published_feed_values` (acceptable in Plan 2B since no production data exists yet).

**Future note (Plan 3+):** When restatements (`revision > 0`) are implemented, extend the ORDER BY key to `(feed_id, feed_version, computed_at, revision)` so that each computation revision has its own dedup group. Without this, a restatement row (`revision = 1, pub_status_rev = 0`) sharing the same `computed_at` as a published original (`revision = 0, pub_status_rev = 1`) would be deduplicated away. Not a Plan 2B concern — all rows use `revision = 0`.

This avoids `ALTER TABLE UPDATE` mutations entirely. The publisher only ever **inserts** — ClickHouse's ReplacingMergeTree handles dedup by keeping the row with the highest `pub_status_rev` for each `(feed_id, feed_version, computed_at)` key.

**Partial success handling:** If Solana succeeds but Base fails (or vice versa), a revision-row is inserted with the successful chain's tx hash and `null` for the failed chain. The failed chain is retried on the next attempt.

### Retry Strategy

3x exponential backoff per chain:
- Attempt 1: immediate
- Attempt 2: 2s delay
- Attempt 3: 4s delay

If all 3 attempts fail for a chain, log the error and move on. The message is committed (no redelivery). The next publication cycle will post a fresh value that supersedes the missed one. This is acceptable because:
- On-chain values are latest-only (no gap matters)
- ClickHouse has the authoritative history
- The publisher posts every heartbeat interval (15 min max)

### Idempotency

`PublicationRequest` identity is `(feed_id, feed_version, computed_at, revision)`. Before posting, the publisher queries ClickHouse for the latest `pub_status_rev` row matching this identity. If `published_solana IS NOT NULL` (or `published_base IS NOT NULL`), skip that chain. This prevents double-posting on consumer restarts.

---

## 5. Worker Integration

### Changes to `apps/worker/src/publisher.ts`

The existing `publishFeedValue` function currently publishes to `TOPICS.INDEX_UPDATES`. It will be extended to also publish a typed `PublicationRequest` to `TOPICS.PUBLICATION`:

```typescript
// After persisting to ClickHouse and publishing INDEX_UPDATES:
const publicationRequest: PublicationRequest = {
  feed_id: result.feedId,
  feed_version: def.version,
  computed_at: now.toISOString(),
  revision: 0,
  value_json: result.valueJson,
  value_usd: result.valueUsd,
  value_index: result.valueIndex,
  confidence: result.completeness, // TODO(Plan 3): use computeConfidence() — currently mirrors completeness as a Plan 2A placeholder
  completeness: result.completeness,
  input_manifest_hash: result.inputManifestHash,
  computation_hash: result.computationHash,
  methodology_version: def.version,
  signer_set_id: envelope.signer_set_id,
  signatures_json: JSON.stringify(envelope.signatures),
}

await producer.publishJson(TOPICS.PUBLICATION, result.feedId, publicationRequest)
```

### What changes in worker code

1. **New type**: `PublicationRequest` added to `@lucid/oracle-core` types
2. **New publish call**: `publishJson(TOPICS.PUBLICATION, ...)` in `publishFeedValue`
3. **No other changes** — worker continues to own computation, attestation, and ClickHouse persistence. The publisher only handles chain posting.

---

## 6. Testing Strategy

### Solana Program Tests

Anchor test framework (`anchor test`) with local validator:
- `initialize_feed` creates correct PDAs with expected values
- `post_report` updates FeedReport with correct values
- `post_report` accepts newer timestamp (normal flow)
- `post_report` accepts same timestamp with higher revision (restatement)
- `post_report` rejects stale timestamp + same/lower revision
- `post_report` rejects wrong authority
- `post_report` rejects Ed25519 instruction with wrong signer (not in signer_set)
- `post_report` rejects Ed25519 instruction with wrong message (mismatched report data)
- `rotate_authority` transfers authority, old authority rejected after rotation

### Base Contract Tests

Foundry test framework (`forge test`):
- `postReport` stores report, emits `ReportPosted` event
- `postReport` accepts newer timestamp (normal flow)
- `postReport` accepts same timestamp with higher revision (restatement)
- `postReport` rejects stale timestamp + same/lower revision
- `postReport` rejects non-authority
- `getLatestReport` returns correct values
- `rotateAuthority` transfers authority, emits event
- `rotateAuthority` rejects zero address

### Publisher Service Tests

Vitest unit tests + integration tests:
- Message consumption and deserialization
- Solana posting logic (mocked RPC)
- Base posting logic (mocked RPC)
- Parallel posting with `Promise.allSettled`
- Retry logic (3x exponential backoff)
- Status-revision row insertion into ClickHouse (pub_status_rev = 1)
- Partial success handling (one chain fails)
- Idempotency check (skip already-published)
- Graceful shutdown

### Worker Integration Tests

- `PublicationRequest` serialization matches expected schema
- `publishFeedValue` publishes to both `INDEX_UPDATES` and `PUBLICATION` topics

---

## 7. Deployment & Operations

### Infrastructure

| Component | Environment | Notes |
|-----------|-------------|-------|
| Solana program | Devnet → Mainnet | Anchor deploy, program upgrade authority = Lucid multisig |
| Base contract | Sepolia → Mainnet | Foundry deploy, authority EOA = Lucid publisher |
| Publisher service | Railway | Alongside worker + API, separate Dockerfile target |

### Dockerfile

Extend the existing multi-target Dockerfile (Plan 2A) with a `publisher` target:

```dockerfile
FROM base AS publisher
CMD ["node", "apps/publisher/dist/index.js"]
```

### Monitoring

- Publisher logs all posting attempts with chain, feed_id, tx_hash or error
- Failed postings tracked via structured logging (for alerting)
- ClickHouse query: feeds with `published_solana IS NULL OR published_base IS NULL` beyond expected age = stale publication

### Key Rotation

Both chains support `rotate_authority`:
- Solana: `rotate_authority` instruction on FeedConfig PDA
- Base: `rotateAuthority()` on LucidOracle contract

Rotation is a separate operational procedure (not automated in Plan 2B). Document the steps for the ops runbook.

---

## 8. File Structure

### New files

```
contracts/
├── solana/
│   ├── Anchor.toml
│   ├── Cargo.toml
│   ├── programs/
│   │   └── lucid-oracle/
│   │       ├── Cargo.toml
│   │       └── src/
│   │           ├── lib.rs              # Program entry, instruction handlers
│   │           ├── state.rs            # FeedConfig, FeedReport account structs
│   │           ├── errors.rs           # Custom error codes
│   │           └── instructions/
│   │               ├── mod.rs
│   │               ├── initialize_feed.rs
│   │               ├── post_report.rs
│   │               └── rotate_authority.rs
│   └── tests/
│       └── lucid-oracle.ts             # Anchor test suite
│
├── base/
│   ├── foundry.toml
│   ├── src/
│   │   └── LucidOracle.sol
│   └── test/
│       └── LucidOracle.t.sol
│
apps/publisher/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                        # Entry point, consumer loop, shutdown
    ├── config.ts                       # PublisherConfig from env
    ├── solana.ts                       # postToSolana()
    ├── base.ts                         # postToBase()
    ├── status.ts                       # pub_status_rev row insertion into ClickHouse
    └── __tests__/
        ├── solana.test.ts
        ├── base.test.ts
        ├── status.test.ts
        └── publisher.test.ts           # Integration test
```

### Modified files

```
packages/core/src/types/publication.ts  # NEW: PublicationRequest type
packages/core/src/index.ts              # Export PublicationRequest
apps/worker/src/publisher.ts            # Add TOPICS.PUBLICATION publish
Dockerfile                              # Add publisher target
migrations/clickhouse/004_add_pub_status_rev.sql  # NEW: drop+recreate published_feed_values with pub_status_rev column, ReplacingMergeTree(pub_status_rev)
```

---

## 9. Dependencies

### Solana Program
- `anchor-lang` ^0.30
- `solana-program` ^1.18

### Base Contract
- `forge-std` (Foundry standard library)
- OpenZeppelin not needed (no proxy, no ERC patterns)

### Publisher Service
- `@coral-xyz/anchor` — Solana client
- `@solana/web3.js` — Transaction construction
- `viem` — Base/EVM client (lighter than ethers)
- `kafkajs` — Redpanda consumer (same as worker)
- `@lucid/oracle-core` — Shared types, ClickHouse client, attestation

---

## 10. Out of Scope (Deferred)

| Item | Deferred to |
|------|-------------|
| Consumer CPI helper (Solana `verify_and_read`) | Plan 3 |
| Consumer SDK crate (Rust) / npm package | Plan 3 |
| MVR bundled report method (Base) | Plan 3 |
| The Graph subgraph | Plan 3 (adapter-only if needed) |
| Redis hot-cache for publication status | Plan 3 |
| Multi-signer operational workflow | Plan 3 |
| On-chain fee collection | Plan 3+ |
| Proxy/upgradability (Base) | Not planned |
| Historical on-chain storage (Solana) | Not planned (ClickHouse is authoritative) |
