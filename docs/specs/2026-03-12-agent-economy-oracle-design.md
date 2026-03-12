# Lucid Agent Economy Oracle — Design Specification

**Date:** 2026-03-12
**Status:** Approved for implementation planning
**Authors:** RaijinLabs + Claude

> We are building the canonical economic data layer for the agent economy, with verifiable publication on-chain and real-time access off-chain.

---

## 1. Product Vision

The Lucid Agent Economy Oracle is a cross-protocol, verifiable economic data network that indexes, aggregates, and publishes agent economic activity across the entire agent economy. It is not an analytics dashboard with oracle features — it is oracle infrastructure with analytics surfaces.

### What It Does

- Indexes agent economic activity across Lucid, Virtuals, Olas, ERC-8004, and on-chain agent wallets
- Resolves cross-protocol agent identities into canonical entities
- Computes verifiable economic indexes (Agent Economy GDP, Activity Index, Protocol Risk)
- Publishes signed oracle feeds on Solana and Base
- Serves real-time data via REST API, MCP tools, SDK, and dashboard

### Who It Serves

| Audience | What they get |
|----------|--------------|
| **Agent developers** | Performance benchmarks, cost analytics, demand signals, reputation scores |
| **DeFi protocols** | On-chain agent reputation feeds, activity indexes for smart contract consumption |
| **Investors & analysts** | Agent economy GDP, protocol leaderboards, growth metrics, Bloomberg-style dashboard |

### Why Lucid Wins

Lucid sits at the gateway layer and sees every request, payment, tool call, and session. Combined with external protocol indexing, this creates a data moat nobody else has. No other project aggregates agent economic fundamentals across protocols as verifiable oracle feeds.

---

## 2. Architecture — Four Planes

The system is cleanly separated into four planes. Each has a single responsibility and well-defined interfaces to the others.

```
┌─────────────────────────────────────────────────────────────────┐
│                        PRODUCT PLANE                            │
│  REST API (Fastify) │ MCP Tools │ Dashboard (Next.js) │ SDK    │
├─────────────────────────────────────────────────────────────────┤
│                      PUBLICATION PLANE                          │
│  Solana Pull Oracle │ Base MVR Push │ Ed25519 Attestation       │
│  Provenance Layer │ Feed Governance │ Report Lineage            │
├─────────────────────────────────────────────────────────────────┤
│                       CONTROL PLANE                             │
│  Identity Resolver │ Feed Definitions │ Protocol Registry       │
│  API Keys │ Billing │ Entitlements │ Privacy Rules              │
├─────────────────────────────────────────────────────────────────┤
│                        DATA PLANE                               │
│  Source Adapters → Redpanda → ClickHouse → Redis                │
│  (Helius, Ponder, Gateway Tap, Protocol APIs)                   │
└─────────────────────────────────────────────────────────────────┘
```

### Plane Responsibilities

**Data Plane** — Ingest, normalize, store, compute. All analytical queries live here.
- Source adapters normalize external data into `raw_economic_events`
- Redpanda is the event backbone (Kafka-compatible, single binary, no JVM)
- ClickHouse is the analytics engine (incremental MVs, not batch ETL)
- Redis is the hot cache and SSE fanout layer

**Control Plane** — Metadata, identity, governance, billing. Postgres/Supabase.
- Identity resolution subsystem
- Feed definitions and versioning
- Protocol registry and source connector configs
- API keys, billing accounts, entitlements

**Publication Plane** — Verifiable on-chain and off-chain delivery.
- Pyth-style pull oracle on Solana
- OCR-style bundled push on Base (MVR pattern)
- Ed25519 multi-signer-ready attestation
- Provenance: methodology, input manifests, revision logs

**Product Plane** — User-facing surfaces. Same nouns, same data, different formats.
- REST API (Fastify :4040)
- MCP tools (MCPGate integration)
- Dashboard (Next.js route group in LucidMerged, thin client consuming oracle API only)
- SDK (@lucidai/oracle on npm)

---

## 3. Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Solana ingestion | Helius Geyser / Webhooks | Already integrated, real-time tx stream |
| EVM indexing | Ponder | TypeScript-native, self-hosted, adapter-only (never the analytics center) |
| Event backbone | Redpanda | Kafka-compatible, C++ single binary, 10x lighter than Kafka |
| Analytics engine | ClickHouse Cloud | 100-1000x faster than PG for aggregations, incremental MVs, pay-per-query |
| Metadata / config | Supabase (Postgres) | Already running, keeps users/tenants/alerts/identity |
| Hot cache | Redis | SSE fanout, rate limits, latest feed values |
| API server | Fastify | Existing pattern in platform-core |
| Agent tools | MCP Server | Existing MCPGate pattern, unique differentiator |
| Dashboard | Next.js (LucidMerged) | Extend existing app, new route group |
| SDK | @lucidai/oracle | TypeScript-first, npm |
| Solana on-chain | Pull oracle program | Consumers pay, Lucid cost stays flat (Pyth model) |
| Base on-chain | MVR push contract | Bundled feeds, heartbeat + deviation trigger |
| Cold archive | S3-compatible object storage | Raw events archived after 90 days |

### Architecture Rules

1. **Ponder is adapter-only.** It writes to Redpanda, not to the analytics layer. Never query Ponder/Postgres for analytical workloads.
2. **ClickHouse is the analytics brain.** All aggregations, rankings, and feed computations happen here.
3. **Redis is the public-facing cache.** Free-tier API queries never touch ClickHouse directly — Redis first, ClickHouse on cache miss.
4. **On-chain contracts are publication-only.** No business logic in smart contracts. They receive signed reports and make them readable.

### Cost at Scale

| Component | 10K agents | 100K agents | 1M agents |
|-----------|-----------|-------------|-----------|
| ClickHouse Cloud | ~$50/mo | ~$200/mo | ~$800/mo |
| Redpanda (Railway) | ~$20/mo | ~$80/mo | ~$300/mo |
| Ponder indexer | ~$15/mo | ~$40/mo | ~$120/mo |
| Helius (Solana) | ~$50/mo | ~$100/mo | ~$250/mo |
| On-chain publishing | ~$10/mo | ~$30/mo | ~$100/mo |
| **Total infra** | **~$145/mo** | **~$450/mo** | **~$1,570/mo** |

Excludes existing infrastructure (Supabase, Railway, Redis) already in use.

---

## 4. Data Model

### 4.1 Canonical Event Store (ClickHouse)

The `raw_economic_events` table is the single source of truth. Append-only, immutable, every source normalizes into this shape.

```sql
CREATE TABLE raw_economic_events (
  -- Identity (deterministic from source + chain + tx_hash + log_index)
  event_id            UUID,

  -- Provenance
  source              LowCardinality(String),   -- 'lucid_gateway' | 'virtuals_acp' | 'olas_gnosis' | ...
  source_adapter_ver  UInt16,                    -- adapter code version
  ingestion_type      LowCardinality(String),   -- 'realtime' | 'backfill' | 'correction'
  ingestion_ts        DateTime64(3),

  -- Chain anchor
  chain               LowCardinality(String),   -- 'solana' | 'base' | 'ethereum' | 'gnosis' | 'offchain'
  block_number        Nullable(UInt64),
  tx_hash             Nullable(String),
  log_index           Nullable(UInt32),

  -- Event classification
  event_type          LowCardinality(String),   -- 'payment' | 'task_complete' | 'tool_call' | ...
  event_timestamp     DateTime64(3),

  -- Entity references
  subject_entity_id   Nullable(String),         -- canonical agent_entity_id (null if unresolved)
  subject_raw_id      String,                   -- raw identifier from source
  subject_id_type     LowCardinality(String),   -- 'wallet' | 'tenant' | 'erc8004' | 'protocol_native'
  counterparty_raw_id Nullable(String),
  protocol            LowCardinality(String),   -- 'lucid' | 'virtuals' | 'olas' | 'independent'

  -- Economic signal
  amount              Nullable(Decimal128(18)),
  currency            Nullable(LowCardinality(String)),
  usd_value           Nullable(Decimal64(6)),

  -- Context metadata
  tool_name           Nullable(String),
  model_id            Nullable(String),
  provider            Nullable(String),
  duration_ms         Nullable(UInt32),
  status              LowCardinality(String),   -- 'success' | 'error' | 'timeout' | 'denied'

  -- Quality
  quality_score       Float32,                  -- 0.0-1.0, set by adapter
  economic_authentic  Bool,                     -- passes economic authenticity rules

  -- Correction chain
  corrects_event_id   Nullable(UUID),           -- points to event this corrects
  correction_reason   Nullable(String)          -- 'reorg' | 'adapter_bug' | 'source_correction'
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_timestamp)
ORDER BY (source, chain, event_type, event_timestamp, event_id)
TTL event_timestamp + INTERVAL 365 DAY;
```

**Idempotent insert**: `event_id` is a deterministic UUID from `(source, chain, tx_hash, log_index)`. Adapters use `INSERT ... SELECT ... WHERE NOT EXISTS` or ClickHouse's `insert_deduplication_token` setting to prevent duplicates. The table uses `MergeTree` (not `ReplacingMergeTree`) because corrections are modeled as new append-only events, not row replacements.

**Corrections**: A correction inserts a **new** event with `ingestion_type = 'correction'` and `corrects_event_id` pointing to the original. The original is never mutated. To query the effective state, exclude superseded events:
```sql
-- Effective events: originals that have NOT been corrected, plus the corrections themselves
SELECT * FROM raw_economic_events
WHERE event_id NOT IN (
  SELECT corrects_event_id FROM raw_economic_events
  WHERE corrects_event_id IS NOT NULL
)
```

**Cold archive**: Raw events older than 90 days are archived to S3 in Parquet format (via ClickHouse `s3()` table function). The 365-day TTL on the ClickHouse table is a safety net — archived data remains queryable via S3-backed external tables.

### 4.2 Materialized View Pipeline

```
raw_economic_events
  → metric_rollups_1m    (MV: auto-aggregates per source × protocol × event_type)
  → metric_rollups_1h    (MV: further aggregation)
  → metric_rollups_1d    (MV: daily summaries)
  → published_feed_values (MV: final feed values with provenance envelope)
```

All are ClickHouse incremental materialized views — they update at insert time, not via batch jobs.

#### Correction Semantics in MVs

Corrections are the main technical nuance with incremental MVs. The rules:

1. **Append-only correction events** — corrections insert new rows into `raw_economic_events` with `ingestion_type = 'correction'` and `corrects_event_id` pointing to the original. The original is never mutated.
2. **Delta adjustments in rollups** — correction events carry both the old value (negative delta) and new value (positive delta). The 1m MV applies the delta, not a full recompute.
3. **Partition recomputation for backfills** — when a new adapter backfills historical data, affected partitions in the rollup tables are dropped and recomputed from raw events. This is a scheduled operation, not real-time.
4. **Correction propagation** — 1m → 1h → 1d MVs propagate corrections via the same delta mechanism. The `feed_revision_log` table records every restatement.

### 4.3 Rollup Table Schemas

#### metric_rollups_1m

```sql
CREATE TABLE metric_rollups_1m (
  bucket              DateTime,                  -- truncated to minute
  source              LowCardinality(String),
  protocol            LowCardinality(String),
  chain               LowCardinality(String),
  event_type          LowCardinality(String),

  -- Aggregates
  event_count         UInt64,
  authentic_count     UInt64,                    -- economic_authentic = true only
  total_usd_value     Decimal64(6),
  avg_usd_value       Float64,
  unique_subjects     AggregateFunction(uniq, String),
  success_count       UInt64,
  error_count         UInt64,
  avg_duration_ms     Float64,

  -- Model/tool breakdowns (for off-chain feeds)
  top_models          AggregateFunction(topK(10), String),
  top_tools           AggregateFunction(topK(10), String)
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (protocol, chain, event_type, bucket);

CREATE MATERIALIZED VIEW metric_rollups_1m_mv TO metric_rollups_1m AS
SELECT
  toStartOfMinute(event_timestamp) AS bucket,
  source, protocol, chain, event_type,
  count() AS event_count,
  countIf(economic_authentic) AS authentic_count,
  sumIf(usd_value, usd_value IS NOT NULL) AS total_usd_value,
  avgIf(usd_value, usd_value IS NOT NULL) AS avg_usd_value,
  uniqState(subject_raw_id) AS unique_subjects,
  countIf(status = 'success') AS success_count,
  countIf(status = 'error') AS error_count,
  avgIf(duration_ms, duration_ms IS NOT NULL) AS avg_duration_ms,
  topKState(10)(model_id) AS top_models,
  topKState(10)(tool_name) AS top_tools
FROM raw_economic_events
WHERE corrects_event_id IS NULL  -- include only original events (exclude correction rows)
GROUP BY bucket, source, protocol, chain, event_type;
```

Correction handling in MVs: Correction events carry the correction's values (not the original's). Since the MV groups by minute bucket, a correction for an event in a different minute bucket creates a new rollup row. For same-bucket corrections, the aggregate naturally includes both the original and correction — downstream feed computation applies the `NOT IN (SELECT corrects_event_id ...)` filter when reading from rollups for final feed values. For backfills that affect large time ranges, affected partitions are dropped and recomputed from raw events via a scheduled job.

#### published_feed_values

```sql
CREATE TABLE published_feed_values (
  feed_id             LowCardinality(String),   -- 'aegdp' | 'aai' | 'apri'
  feed_version        UInt16,
  computed_at         DateTime64(3),
  revision            UInt16,                    -- 0 = original, 1+ = restatement

  -- Feed value
  value_json          String,                    -- JSON-encoded feed-specific payload
  value_usd           Nullable(Decimal64(6)),    -- primary USD value (for AEGDP)
  value_index         Nullable(Float64),         -- primary index value (for AAI)

  -- Quality envelope
  confidence          Float32,
  completeness        Float32,
  freshness_ms        UInt32,
  revision_status     LowCardinality(String),   -- 'preliminary' | 'revised' | 'final' | 'exceptional'
  source_coverage     String,                    -- JSON map of source → bool

  -- Provenance
  input_manifest_hash String,                    -- SHA256 of input event set
  computation_hash    String,                    -- SHA256 of feed spec code version
  methodology_version UInt16,

  -- Attestation
  signer_set_id       String,
  signatures_json     String,                    -- JSON array of {signer, sig}

  -- Publication status
  published_solana    Bool DEFAULT false,
  published_base      Bool DEFAULT false,
  solana_slot         Nullable(UInt64),
  base_tx_hash        Nullable(String)
) ENGINE = ReplacingMergeTree(revision)
PARTITION BY toYYYYMM(computed_at)
ORDER BY (feed_id, computed_at, feed_version);
```

Here `ReplacingMergeTree(revision)` is correct: when a feed value is restated, the new row with a higher `revision` number replaces the old one for the same `(feed_id, computed_at, feed_version)` key.

Note: This MV includes original events even if they are later corrected. Downstream feed computation (the `published_feed_values` computation job) applies the `NOT IN (SELECT corrects_event_id ...)` filter to exclude superseded originals before computing final feed values. This two-stage approach avoids the complexity of retroactively modifying rollup rows while keeping final feed values accurate.

### 4.4 Analytics Tables (ClickHouse)

| Table | Purpose |
|-------|---------|
| `raw_economic_events` | Canonical append-only truth |
| `normalized_agent_actions` | Denormalized view with resolved entity IDs |
| `normalized_payment_flows` | Payment-specific events with settlement status |
| `entity_relationship_edges` | Agent-to-agent, agent-to-protocol relationships |
| `protocol_state_snapshots` | Periodic protocol-level state snapshots |
| `metric_rollups_1m` | 1-minute aggregations |
| `metric_rollups_1h` | 1-hour aggregations |
| `metric_rollups_1d` | 1-day aggregations |
| `published_feed_values` | Final feed values with provenance |
| `feed_revision_log` | Every restatement tracked |

### 4.5 Control Plane Tables (Postgres/Supabase)

| Table | Purpose |
|-------|---------|
| `agent_entities` | Canonical agent identity records |
| `wallet_mappings` | Wallet → entity resolution |
| `identity_links` | Cross-protocol identity links with confidence |
| `identity_evidence` | Evidence supporting each link |
| `protocol_registry` | Indexed protocol definitions |
| `source_connectors` | Adapter configs per data source |
| `feed_definitions` | Computation spec, inputs, methodology |
| `feed_versions` | Schema evolution tracking |
| `feed_inputs` | Which raw events feed each index |
| `attestation_jobs` | Pending/completed attestation work |
| `api_keys` | Oracle API access |
| `subscriptions` | Alerts, webhooks, SSE channels |
| `billing_accounts` | Free / pro / growth tiers |
| `mcp_tool_entitlements` | Which tools per tier |
| `usage_metering` | API call counts per key |

---

## 5. Identity Resolution

Cross-protocol identity resolution is a first-class subsystem, not an afterthought. The hardest problem in the system.

### 5.1 Entity Model

```
Raw identifiers:              → Resolution →     Canonical entity:
  Solana wallet 7xK...9pQ                         agent_entity_id: ae_7f3k9x2m
  EVM wallet 0xA3f...8c2                            wallets: 2 (sol + evm)
  Gateway tenant tnt_abc123                         protocols: 3
  ERC-8004 ID #4821                                 reputation: 847
  Virtuals agent vrt_0x7f...                        total_output: $12,430
  Olas service svc_42
```

### 5.2 Resolution Strategies (layered, highest confidence first)

1. **Explicit claim** (confidence: 0.95-1.0) — Agent registers wallets via API with signed message verification
2. **On-chain proof** (confidence: 0.85-0.95) — ERC-8004 registry lookup, on-chain identity contract verification
3. **Gateway correlation** (confidence: 0.60-0.80) — Same API key uses multiple wallets, session-level correlation
4. **Behavioral heuristic** (confidence: 0.30-0.55) — Timing patterns, interaction graphs, co-occurrence analysis

### 5.3 ERC-8004 Positioning

ERC-8004 is the **highest-confidence external identity source** but is treated as enrichment, not a dependency. Agents without ERC-8004 registration are fully functional — they resolve via other strategies at lower confidence. This avoids anchoring on a standard that is still maturing.

---

## 6. Trustworthy Computation Pipeline

This is what separates an oracle from a dashboard. Every published value must be traceable, replayable, and verifiable.

### 6.1 Pipeline Stages

```
1. RAW EVENT   → Immutable, append-only, canonical hash
2. NORMALIZE   → Deterministic, versioned schema, replayable
3. COMPUTE     → Feed spec = code, input manifest, deterministic output
4. ATTEST      → Ed25519 sign, multi-signer ready, report receipt
5. PUBLISH     → On-chain feed, API + SSE, revision tracked
```

### 6.2 Confidence Methodology

Every metric carries a deterministic confidence score. The formula is versioned and published.

```
// All inputs normalized to 0.0-1.0 where higher = more confident
confidence = weighted_mean(
  source_diversity_score     × 0.25,   // [0,1] — ratio of reporting sources to expected sources
  identity_confidence        × 0.20,   // [0,1] — avg entity resolution confidence of contributing agents
  data_completeness          × 0.20,   // [0,1] — % of expected data points present
  anomaly_cleanliness        × 0.15,   // [0,1] — 1.0 if clean, decays with each detected anomaly
  freshness_score            × 0.10,   // [0,1] — exp(-age_seconds / expected_update_interval)
  revision_stability         × 0.10    // [0,1] — 1.0 - revision_probability (inverted: higher = more stable)
)
```

Note: `revision_stability` = `1.0 - revision_probability`, so all six inputs follow the same convention: higher value = higher confidence.

The formula version is embedded in every attestation. If the formula changes, the feed version increments.

Every response includes first-class quality fields:

```typescript
{
  value: 847_000_000,
  quality: {
    confidence: 0.97,
    completeness: 0.83,
    freshness_ms: 2400,
    staleness_risk: 'low',
    revision: 'final',
    source_coverage: { lucid: true, virtuals: true, olas: true, erc8004: false }
  }
}
```

### 6.3 Finalization Stages

```
preliminary   →  0 to 10 min    (live, may change)
revised       →  10 min to 6h   (most sources finalized)
final         →  6h+            (all chains finalized)
exceptional   →  any time       (reorg, adapter bug, source outage)
```

- `final` values can be restated via `exceptional` with correction pointer, public explanation, and methodology note
- Every restatement logged in `feed_revision_log` with `reason`, `old_value`, `new_value`, `correction_source`
- Consumers can subscribe to restatement events via SSE/webhook

### 6.4 Economic Authenticity Rule

> **Only economically meaningful activity materially influences core indexes.**

AEGDP and AAI are weighted by:
- Signed payment completion (x402 proof or on-chain tx)
- Actual cost incurred (verified spend)
- External counterparty interaction (not self-loops)
- Session/task completion (not abandoned/failed)
- Distinct tool/model/provider usage
- Identity confidence >= 0.6

Syntactic event counts are secondary signals for the Activity Index but never for GDP or reputation feeds.

### 6.5 Anti-Gaming Protections

- **Sybil resistance**: Low-confidence entities (<0.5) excluded from reputation feeds
- **Wash detection**: Self-loops (A→B→A) within short windows flagged and excluded from AEGDP
- **Volume inflation**: Weighted by economic value, not raw count
- **Spoofed claims**: Explicit claims require signed message verification
- **Tool-call spam**: Rate limiting + cost-weighted activity contribution
- **Circuit breaker**: If any single source >40% of a feed's value, flag and investigate

---

## 7. Privacy & Aggregation Release Rules

### 7.1 Core Principle

No tenant-specific data is exposed unless the tenant opts in via `oracle_visibility: 'public'` in their config.

### 7.2 Dimensional Release Rules

Privacy thresholds depend on multiple factors, not a single global k-value:

| Factor | Rule |
|--------|------|
| Contributor threshold | min 5 for broad slices, min 20 for narrow slices |
| Dominance cap | If top contributor >60% of slice value, suppress or band |
| Category sensitivity | Model usage, cost data = higher thresholds |
| Time bucketing | Narrow categories get coarser time windows (1h → 6h → 1d) |
| Range banding | Individual values reported in ranges below threshold |
| Slice cardinality | If (category × chain × time) has <threshold, merge to next coarser bucket |

### 7.3 Delayed Publication

Sensitive slices (model usage, cost per task) published with 1-hour delay minimum. Agent revenue banded unless self-reported.

---

## 8. On-Chain Publication

### 8.1 V1 Feeds (3 bundled metrics)

| Feed | Description | Chains |
|------|-------------|--------|
| **AEGDP** | Agent Economy GDP — total economic output across all indexed protocols | Solana + Base |
| **AAI** | Agent Activity Index — composite of active agents, tasks/sec, tool calls, unique interactions | Solana + Base |
| **APRI** | Agent Protocol Risk Index — bundled health scores, reliability tiers, error rates, concentration | Solana + Base |

All other metrics (Model Usage, Cost Index, Tool Popularity) are off-chain first (API + dashboard). Promoted to on-chain in v2 based on demand.

### 8.2 Solana — Pull Oracle (Pyth model)

Signed reports are posted off-chain to a report server. Consumers pull and verify on-demand. Cost: ~$0.00025 per verification (paid by consumer). Lucid's cost stays flat.

#### Program Account Structure

```
LucidOracleProgram (Anchor/native)
├── FeedConfig (PDA: [b"feed", feed_id])
│   ├── feed_id:        [u8; 16]        // e.g., "aegdp\0..."
│   ├── feed_version:   u16
│   ├── authority:      Pubkey           // Lucid signer (upgradable to multisig)
│   ├── min_signers:    u8               // 1 at launch, N later
│   ├── signer_set:     Vec<Pubkey>      // authorized signers
│   └── update_cadence: u32             // expected seconds between updates
│
├── FeedReport (PDA: [b"report", feed_id, timestamp_be_bytes])
│   ├── feed_id:              [u8; 16]
│   ├── feed_version:         u16
│   ├── report_timestamp:     i64
│   ├── values:               Vec<FeedValue>  // [{key, value_u64, decimals}]
│   ├── confidence:           u16             // basis points (9700 = 0.97)
│   ├── revision:             u16
│   ├── input_manifest_hash:  [u8; 32]
│   ├── computation_hash:     [u8; 32]
│   └── signatures:           Vec<Signature>  // Ed25519 sigs
│
└── Instructions
    ├── initialize_feed(feed_id, signer_set, update_cadence)
    ├── post_report(report_data, signatures)      // authority-only
    ├── verify_and_read(feed_id, max_age_secs)    // CPI for consumers
    └── update_signer_set(new_signers, min_signers)
```

#### Consumer CPI Flow

```rust
// In consumer's Solana program:
let report = LucidOracle::verify_and_read(
    ctx.accounts.feed_report,
    ctx.accounts.feed_config,
    max_age_secs: 300,  // reject if older than 5 min
)?;
// report.values[0].value = AEGDP in USD (6 decimals)
// report.confidence = 9700 (97%)
```

#### Ed25519 Verification

Reports are verified using Solana's native Ed25519 precompile (`Ed25519SigVerify111111111111111111111111111`). The `post_report` instruction includes the Ed25519 verify instruction in the same transaction. Consumers calling `verify_and_read` trust the on-chain report (already verified at post time) and only check freshness + signer authority.

### 8.3 Base — MVR Push Oracle (OCR-inspired)

All 3 feeds bundled in one contract update (multi-value report pattern). Heartbeat: every 5 minutes or on 1% deviation. Cost: ~$0.01/update × ~288/day = ~$2.88/day.

#### Contract Interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILucidOracle {
    struct FeedReport {
        bytes16  feedId;
        uint16   feedVersion;
        uint64   reportTimestamp;
        uint16   confidence;        // basis points (9700 = 0.97)
        uint16   revision;
        bytes32  inputManifestHash;
        bytes32  computationHash;
        FeedValue[] values;
    }

    struct FeedValue {
        bytes16 key;                // "aegdp", "aai", "apri"
        uint256 value;              // scaled by decimals
        uint8   decimals;
    }

    // --- Write (authorized updater only) ---
    function postReport(
        FeedReport calldata report,
        bytes[] calldata signatures  // Ed25519 sigs (verified via precompile)
    ) external;

    // --- Read (public) ---
    function getLatestReport() external view returns (FeedReport memory);
    function getFeedValue(bytes16 key) external view returns (uint256 value, uint64 timestamp, uint16 confidence);
    function getAgentReputation(bytes32 agentEntityId) external view returns (uint16 score, uint64 lastUpdate);
    function verifyReport(bytes calldata reportBytes, bytes calldata signature) external view returns (bool);

    // --- Admin ---
    function updateSignerSet(address[] calldata newSigners, uint8 minSigners) external;
}
```

#### Access Control

- `postReport`: restricted to authorized updater EOA (Lucid's oracle publisher). Upgradable to multisig via `updateSignerSet`.
- All read functions: public, no auth required.
- Ed25519 signature verification uses EVM's `ecrecover` for ECDSA or a verifier precompile for Ed25519 (Base supports `0x05` precompile).
- Report data is ABI-encoded for on-chain storage. The same data is Borsh-encoded for the Solana program.

### 8.4 Report Provenance Envelope

Every on-chain update carries full lineage:

```typescript
{
  feed_id:              "aegdp",
  feed_version:         3,
  report_timestamp:     1710288000,
  signer_set_id:        "ss_lucid_v1",       // multi-signer ready
  input_manifest_hash:  "0xabc...def",        // SHA256 of input event set
  computation_hash:     "0x123...456",        // SHA256 of feed spec version
  revision:             0,                     // 0 = original, 1+ = restatement
  values: {
    aegdp: 847_000_000,
    aai:   12_847,
    apri:  { protocol_health: 92, agent_reliability: 87 }
  },
  signatures: [
    { signer: "0x...", sig: "0x..." }          // N-of-M ready
  ]
}
```

Any integrator can trace `input_manifest_hash` back to the exact set of raw events that produced the value.

### 8.5 Multi-Signer Path

The attestation format supports N-of-M signatures from day one. Lucid is the only signer at launch. Adding independent verifiers later is an operational upgrade, not an architectural rewrite.

---

## 9. API Surface

### 9.1 Six Core Nouns

Every surface uses these exact entities. A developer learns them once, uses them everywhere.

| Noun | Definition |
|------|-----------|
| **Agent** | A resolved entity across protocols, wallets, and identities |
| **Protocol** | An indexed platform (Lucid, Virtuals, Olas, etc.) |
| **Feed** | A computed index (AEGDP, AAI, APRI) |
| **Report** | A signed, verifiable feed snapshot |
| **Metric** | A raw data point (revenue, calls, errors) |
| **Attestation** | Cryptographic proof of a report's validity |

### 9.2 REST API — /v1/oracle/*

#### Feeds

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /v1/oracle/feeds | List all published feeds | Free |
| GET | /v1/oracle/feeds/:id | Latest value + metadata + methodology | Free |
| GET | /v1/oracle/feeds/:id/history | Historical values (7d free, 90d pro) | Tiered |
| GET | /v1/oracle/feeds/:id/methodology | Computation spec, inputs, version | Free |

#### Agents

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /v1/oracle/agents/:id | Agent profile: reputation, wallets, protocols | Free |
| GET | /v1/oracle/agents/:id/metrics | Revenue, tasks, cost, error rate, uptime | Pro |
| GET | /v1/oracle/agents/:id/activity | Recent actions across protocols | Pro |
| GET | /v1/oracle/agents/search | Search by wallet, protocol ID, ERC-8004 | Free |
| POST | /v1/oracle/agents/register | Claim wallets + link identities | Free |
| GET | /v1/oracle/agents/leaderboard | Top agents by revenue, activity, reputation | Free |

#### Protocols

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /v1/oracle/protocols | All indexed protocols + summary stats | Free |
| GET | /v1/oracle/protocols/:id | Protocol detail: agents, revenue, health | Free |
| GET | /v1/oracle/protocols/:id/metrics | Deep metrics: agent count, vol, growth | Pro |

#### Reports

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /v1/oracle/reports/latest | Latest signed report (all bundled feeds) | Free |
| GET | /v1/oracle/reports/:id | Specific report + attestation + inputs | Free |
| POST | /v1/oracle/reports/:id/verify | Verify attestation signature + inputs | Free |

#### Streaming & Alerts

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | /v1/oracle/stream | SSE: feed updates, agent events, reports | Pro |
| POST | /v1/oracle/alerts | Create webhook alert | Pro |
| GET | /v1/oracle/alerts | List active alerts | Pro |

### 9.3 MCP Tools

#### Free Tier — 5 Core Tools

| Tool | Description |
|------|-------------|
| `oracle_economy_snapshot` | Current state: AEGDP, AAI, APRI, 24h change, top protocols |
| `oracle_agent_lookup` | Agent profile: reputation, protocols, wallet count, output |
| `oracle_protocol_stats` | Protocol comparison: agents, revenue, volume, health |
| `oracle_feed_value` | Current feed value with confidence and methodology link |
| `oracle_verify_report` | Verify report signature, input match, on-chain link |

#### Pro Tier — 10+ Advanced Tools

| Tool | Description |
|------|-------------|
| `oracle_agent_deep_metrics` | Full metrics: revenue, cost/task, error rate, uptime history |
| `oracle_agent_compare` | Side-by-side agent comparison on performance |
| `oracle_feed_history` | Time series with rollup intervals (1m, 1h, 1d) |
| `oracle_model_usage` | LLM distribution: GPT-4 vs Claude vs open-source |
| `oracle_tool_popularity` | Top MCP tools by call volume, growth, error rate |
| `oracle_cost_index` | Average cost/task by category, provider, model |
| `oracle_chain_heatmap` | Agent activity concentration by chain |
| `oracle_set_alert` | Create webhook alert on threshold breach |
| `oracle_demand_signals` | Unmet demand: failed tool lookups, error patterns |
| `oracle_raw_query` | Structured query builder with entitlement checks (see Security note below) |

**`oracle_raw_query` Security**: This tool does NOT expose raw SQL. It accepts a structured query object with predefined dimensions (protocol, chain, event_type, time_range) and measures (count, sum_usd, avg_duration). The query builder validates all inputs against an allowlist of queryable fields, enforces the caller's tier-based time range limits, applies privacy release rules before returning results, and enforces a 10-second ClickHouse query timeout. Growth-tier users can request async queries (returned via webhook) with a 60-second timeout.

### 9.4 SDK — @lucidai/oracle

TypeScript-first SDK with the same 6 nouns:

```typescript
import { LucidOracle } from '@lucidai/oracle'

const oracle = new LucidOracle({ apiKey: process.env.LUCID_KEY })

// Feeds
const gdp = await oracle.feeds.get('aegdp')
const history = await oracle.feeds.history('aegdp', { period: '30d' })

// Agents
const agent = await oracle.agents.get('ae_7f3k9x2m')
const results = await oracle.agents.search({ wallet: '7xK...9pQ' })
const leaders = await oracle.agents.leaderboard({ sort: 'revenue' })

// Protocols
const protos = await oracle.protocols.list({ sort: 'revenue' })

// Reports
const report = await oracle.reports.latest()
const valid = await oracle.reports.verify('rpt_abc123')

// Streaming (Pro)
oracle.stream('aegdp', (update) => {
  console.log(update.value, update.attestation)
})
```

On-chain consumer SDKs:

- `@lucidai/oracle-sol` — Solana program CPI helper
- `@lucidai/oracle-evm` — Base/EVM contract consumer

---

## 10. Dashboard UX

### 10.1 Principles

The dashboard is a **trust interface**, not an analytics dashboard.

- **Live by default** — data streams via SSE, sparklines animate, freshness counters tick
- **Drillable everything** — AEGDP → protocol breakdown → top agents → agent timeline → wallets
- **Verifiable by design** — every number links to methodology, on-chain report, API equivalent
- **Progressive access** — free sees everything on overview, pro unlocks per-agent drilldowns

### 10.2 The Rule

Every chart, every number, every card has these six links:

1. **Methodology** — how was this computed?
2. **Freshness** — how old is this data?
3. **Confidence** — how reliable is this?
4. **On-chain report** — verify on Solana/Base
5. **API equivalent** — `GET /v1/oracle/feeds/aegdp`
6. **MCP tool** — `oracle_economy_snapshot`

### 10.3 Pages

| Page | Content | Tier |
|------|---------|------|
| **Overview** | Hero feeds (AEGDP, AAI, APRI) + protocol leaderboard + chain heatmap | Free |
| **Agents** | Agent explorer with search, leaderboard, profile pages | Free (basic), Pro (deep metrics) |
| **Protocols** | Protocol detail pages with agent lists, revenue, health | Free (basic), Pro (deep) |
| **Feeds** | Feed detail pages with history charts, methodology docs | Free (7d), Pro (90d) |
| **Reports** | Report browser with attestation verification | Free |
| **API** | Interactive API docs, key management, usage dashboard | Free |

---

## 11. Freemium Model

### 11.1 Tier Structure

| | **Free** | **Pro** ($99/mo) | **Growth** (custom) |
|---|---|---|---|
| Dashboard | Full real-time indexes | + per-agent drilldowns | + white-label embeds |
| API | 1,000 calls/day | 50,000 calls/day | Unlimited + SLA |
| MCP Tools | 5 core tools | 15+ tools | + custom tools |
| Data freshness | Real-time aggregates | + real-time per-agent | + raw event stream |
| History | 7 days | 90 days | Unlimited |
| On-chain feeds | Read (public) | + attestation verify | + custom feed creation |
| Alerts | None | 10 webhooks | Unlimited + Slack/Discord |
| Streaming (SSE) | None | 3 channels | Unlimited + firehose |
| Cross-protocol | Top-level only | Full correlation | + raw data export |

### 11.2 Flywheel Logic

- **Free MCP tools drive agent adoption** — every agent querying the oracle is also a data source
- **Real-time on free** (not delayed) — delayed data kills adoption and competitors undercut
- **Gate on depth and volume**, not freshness — methodology pages are always free

### 11.3 Cost Guardrails

- **Precomputed rollups** for common queries — free tier never touches raw events
- **Cache-first public endpoints** — `/feeds/:id` served from Redis
- **Query tiering** — Free = precomputed only, Pro = ClickHouse with 10s timeout, Growth = extended + async
- **Raw export only on Growth** — prevents ClickHouse bill explosion
- **Monthly query unit budget on Pro** — complex historical queries consume more units

---

## 12. Latency SLOs

| Surface | Target | SLO |
|---------|--------|-----|
| API `/feeds/:id` (latest) | <1s (Redis) | 99.9% |
| API `/agents/:id` | <2s | 99.5% |
| API `/feeds/:id/history` | <3s (ClickHouse) | 99.5% |
| Dashboard aggregates | 5-30s | 99.5% |
| SSE stream updates | <10s from event | 99% |
| On-chain Solana | 1-5 min cadence | 99% |
| On-chain Base | 5 min heartbeat / 1% deviation | 99% |
| Historical deep queries | <10s or async | 95% |
| Report attestation availability | <30s from computation | 99.9% |

---

## 13. External Data Ingestion

### 13.1 Source Adapters

| Source | Protocol | Chain | Method |
|--------|----------|-------|--------|
| **Lucid Gateway** | Lucid | offchain | Internal event tap (x402, usage, sessions) |
| **Virtuals ACP** | Virtuals | Base | Ponder indexer on ACP contracts |
| **Olas** | Olas | Gnosis, Base, Optimism | Ponder indexer on agent registry + marketplace |
| **ERC-8004** | Identity standard | Ethereum | Ponder indexer on Identity/Reputation/Validation registries |
| **Agent wallets** | Various | Solana | Helius webhooks for known agent wallets |
| **Agent wallets** | Various | EVM | Ponder / Alchemy webhooks for known agent wallets |
| **Cookie.fun** | Cookie DAO | offchain | API enrichment (social/mindshare data) |

### 13.2 Adapter Contract

Every adapter must:
1. Normalize events into `raw_economic_events` schema
2. Set `quality_score` based on data completeness
3. Set `economic_authentic` based on economic authenticity rules
4. Produce deterministic `event_id` from natural key
5. Publish to Redpanda topic `raw.{source}.events`
6. Support backfill mode for historical data

---

## 14. V1 On-Chain Feeds

Three feeds, bundled, on two chains. Tight scope.

| Feed | Computation | Update Trigger |
|------|-------------|----------------|
| **AEGDP** | Sum of: payments processed + (tasks completed × avg value) + revenue distributed, across all indexed protocols | 5 min heartbeat or 1% deviation |
| **AAI** | Composite of: 7d active agents + tasks/sec + tool calls/sec + unique interactions + cross-protocol tx count | 5 min heartbeat or 2% deviation |
| **APRI** | Weighted bundle: protocol health scores + agent reliability tiers + error rates + economic concentration | 5 min heartbeat or 5% deviation |

All other metrics (Model Usage Distribution, Cost Index, Tool Popularity, Chain Heatmap) are API + dashboard only in v1.

---

## 15. Future Path: Network Credibility

The system is designed for a clean upgrade path from single-operator to network-grade oracle:

1. **Day one**: Lucid is sole signer. All reports carry single Ed25519 signature.
2. **Phase 2**: Add 2-3 independent verifiers running deterministic feed specs against the same raw events. Reports require 2-of-3 signatures.
3. **Phase 3**: Open verifier participation. Published feed specs are deterministic code. Anyone can replay and verify. N-of-M threshold signatures.

No architecture changes required — the attestation format, feed spec versioning, and input manifest system are all designed for this transition.

---

## 16. Gateway Tap — Lucid-Native Event Inventory

The Lucid Gateway Tap adapter translates existing gateway telemetry into `raw_economic_events`. Here is what the gateway already emits and how each maps to oracle events:

| Gateway Source | Table/System | Oracle Event Type | Key Fields |
|---------------|-------------|-------------------|------------|
| LLM inference | `openmeter_event_ledger` | `llm_inference` | tenant_id, model, provider, tokens (in/out), status, trace_id |
| LLM receipt | `receipt_events` | `llm_inference` | model_passport_id, compute_passport_id, tokens_in/out, endpoint |
| MCP tool call | `mcpgate_audit_log` | `tool_call` | tenant_id, server_id, tool_name, status, duration_ms, args_hash |
| x402 payment | `gateway_payment_sessions` | `payment` | tenant_id, token, amount, chain, tx_hash, status |
| x402 proof | `gateway_spent_proofs` | `payment` | proof_hash, chain (via header) |
| Settlement | `gateway_settlement_receipts` | `payment` | chain, tx_hash, facilitator, amount, token, recipient |
| Quota usage | `gateway_quota_usage` | (derived) | tenant_id, service, request_count, period |
| Agent reputation | `gateway_agent_reputation` | `reputation_update` | agent_id, score, tier, total_payments, success_rate |

**Not currently emitted but needed:**
- Per-request latency to upstream LLM (available in metering code but not persisted — add to receipt_events)
- Agent ID per TrustGate request (currently only in MCPGate sessions — extend `X-Agent-Id` header to TrustGate)
- PayCascade split execution details (currently fire-and-forget — add settlement receipt per split stage)

The Gateway Tap adapter reads from these tables/streams and publishes to Redpanda topic `raw.lucid_gateway.events`. For real-time ingestion, it uses PostgreSQL LISTEN/NOTIFY on insert triggers for `receipt_events` and `mcpgate_audit_log`. For backfill, it scans tables by `created_at` range.

---

## 17. Identity Merge & Split Protocol

### 17.1 Merge (two entities discovered to be the same agent)

1. **Detection**: Identity resolver finds high-confidence link between two existing `agent_entity_id` values (e.g., both wallets signed by same key)
2. **Canonical selection**: Entity with more activity history becomes the surviving ID. The other becomes an alias.
3. **Control plane update**: `identity_links` table records the merge with `link_type = 'merge'`, `surviving_id`, `merged_id`
4. **ClickHouse backfill**: A scheduled job updates `subject_entity_id` in `normalized_agent_actions` for the merged entity's events. Raw events are never mutated — only the denormalized view is updated.
5. **Feed recomputation**: Agent-level feeds (reputation, metrics) are recomputed for the surviving entity. Aggregate feeds (AEGDP, AAI) are unaffected since they already counted the activity.

### 17.2 Split (one entity discovered to be two distinct agents)

1. **Detection**: Behavioral analysis reveals an entity ID was incorrectly grouping two agents (e.g., shared wallet used by different operators)
2. **New entity creation**: A new `agent_entity_id` is created for the split-off agent
3. **Event reassignment**: Events are reassigned to the new entity based on heuristics (time range, tool patterns, chain). Ambiguous events remain with the original entity.
4. **Confidence downgrade**: Both entities get their identity confidence scores reduced proportionally
5. **Feed recomputation**: Both entities' metrics are recomputed. Aggregate feeds may need restatement if the split materially changes GDP/activity attribution.

### 17.3 Downstream Propagation

- Merges/splits generate `identity_resolution` events in Redpanda
- ClickHouse MVs on `normalized_agent_actions` are recomputed for affected partitions
- `published_feed_values` entries affected by the resolution change are restated with `revision_status = 'exceptional'` and `correction_reason = 'identity_resolution'`

---

## 18. Degradation & Error Handling

### 18.1 Component Failure Modes

| Component | Failure | Behavior |
|-----------|---------|----------|
| **ClickHouse down** | API serves stale data from Redis for up to 5 minutes. After 5 min, `/feeds/:id` returns last known value with `staleness_risk: 'high'`. History/deep queries return 503. |
| **Redpanda down** | Source adapters buffer events locally (bounded at 10K events / 50MB per adapter). If buffer fills, adapters drop oldest events and log. Recovery: adapters replay from buffer on reconnect. |
| **Source adapter fails** | Feed continues publishing with reduced `completeness` score. If a source is missing for >15 min, `source_coverage` reflects it and `confidence` drops accordingly. Feed never halts — it publishes with available data. |
| **Redis down** | API falls through to ClickHouse directly. Latency increases but correctness preserved. SSE streams reconnect with last-event-id. |
| **On-chain publish fails** | Retry 3x with exponential backoff. After 3 failures, alert operator and continue off-chain publication. On-chain feed shows stale timestamp — consumers check `max_age` and act accordingly. |
| **Identity resolver fails** | New events ingested with `subject_entity_id = NULL`. Resolved in batch when service recovers. Aggregate feeds unaffected (they work with raw IDs too). |

### 18.2 Staleness Indicators

Every API response includes `staleness_risk`:
- `low`: freshness < 2× expected update interval
- `medium`: freshness between 2× and 5× expected interval
- `high`: freshness > 5× expected interval

On-chain consumers use `max_age_secs` parameter to reject stale data at the smart contract / program level.

---

## 19. Authentication & Billing Integration

The oracle API reuses the existing gateway authentication and billing infrastructure. It does not create parallel tables.

| Oracle Concept | Gateway Infrastructure |
|---------------|----------------------|
| Oracle API keys | `gateway_api_keys` table (same keys, add `oracle` to scopes) |
| Tenant identity | `gateway_tenants` table (same tenant IDs) |
| Billing | Existing Stripe integration via `cloud/billing/` |
| Quota enforcement | `gateway_quota_usage` table (add `oracle` service) |
| Plan limits | Extend `PLAN_LIMITS` in `plan-config.ts` with oracle-specific limits |

Oracle access is controlled by adding `oracle` to a tenant's API key scopes. Free tier = default for all tenants. Pro/Growth = requires active Stripe subscription with oracle add-on.

The oracle API server (:4040) uses the same `resolveTenantIdAsync()` auth hook as TrustGate/MCPGate, reading from the shared `gateway_api_keys` table.

---

## 20. Redpanda Operational Design

### 20.1 Topic Structure

| Topic | Partitions | Retention | Producers | Consumers |
|-------|-----------|-----------|-----------|-----------|
| `raw.lucid_gateway.events` | 6 | 7 days | Gateway Tap adapter | ClickHouse ClickPipes |
| `raw.virtuals_acp.events` | 3 | 7 days | Virtuals Ponder adapter | ClickHouse ClickPipes |
| `raw.olas.events` | 3 | 7 days | Olas Ponder adapter | ClickHouse ClickPipes |
| `raw.erc8004.events` | 2 | 7 days | ERC-8004 Ponder adapter | ClickHouse ClickPipes |
| `raw.agent_wallets.events` | 4 | 7 days | Helius/Alchemy webhook handlers | ClickHouse ClickPipes |
| `normalized.economic` | 8 | 3 days | Normalization workers | Feed computation workers |
| `index.updates` | 3 | 1 day | Feed computation workers | Redis cache updater, SSE fanout |
| `publication.requests` | 2 | 1 day | Feed computation workers | Solana/Base publishers |

### 20.2 Partitioning Strategy

- Raw topics: partitioned by `hash(source + chain)` for even distribution
- Normalized topic: partitioned by `hash(protocol)` for per-protocol ordering
- Index/publication topics: partitioned by `feed_id` for per-feed ordering

### 20.3 Consumer Groups

- `clickhouse-ingest`: Consumes raw topics → ClickHouse bulk insert (batch: 10K events or 5s)
- `normalizer`: Consumes raw → normalizes → produces to `normalized.economic`
- `feed-computer`: Consumes normalized → computes feed values → produces to `index.updates` + `publication.requests`
- `redis-updater`: Consumes index updates → writes to Redis hot cache
- `sse-fanout`: Consumes index updates → pushes to connected SSE clients
- `chain-publisher`: Consumes publication requests → posts to Solana/Base

### 20.4 Backpressure

If a consumer group falls behind by >100K messages, Redpanda alerts the operator. The system is designed so consumers can catch up by processing in larger batches — ClickHouse handles bulk inserts efficiently. At 1M agents with ~100 events/agent/day, peak throughput is ~1,200 events/sec — well within Redpanda's single-node capacity (100K+ msg/sec).

---

## 21. Dashboard as Thin Client

The dashboard is a Next.js route group within LucidMerged (`(oracle)/`). It is a **thin client** that consumes the oracle's REST API (:4040) exclusively. It does not query ClickHouse, Redpanda, or Redis directly.

```
Browser → LucidMerged (Vercel)
            └── (oracle)/ route group
                  └── Server components call oracle API (:4040)
                        └── SSE streams via EventSource to oracle API
```

All data flows through the oracle API. The dashboard never imports oracle-internal modules or connects to oracle infrastructure. This ensures the dashboard enforces the same tier/entitlement rules as any other API consumer.

---

## Glossary

| Term | Definition |
|------|-----------|
| **AEGDP** | Agent Economy GDP — total economic output across indexed protocols |
| **AAI** | Agent Activity Index — composite activity metric |
| **APRI** | Agent Protocol Risk Index — bundled risk/health scores |
| **Decision Pack** | Legacy term from market oracle; replaced by Feed + Report in this design |
| **Economic authenticity** | Rule that only meaningful economic activity influences core indexes |
| **Feed** | A computed, versioned, published index |
| **MVR** | Multi-Value Report — bundling multiple feed values in one on-chain update |
| **OCR** | Off-Chain Reporting — aggregating observations off-chain, publishing one signed result on-chain |
| **Provenance** | The complete lineage from raw event to published value |
| **Report** | A signed snapshot of one or more feed values at a point in time |
