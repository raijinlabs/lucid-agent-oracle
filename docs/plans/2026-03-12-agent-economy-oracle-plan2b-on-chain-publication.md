# Plan 2B: On-Chain Publication — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish attested oracle feed values (AEGDP/AAI/APRI) on-chain to Solana and Base via a slim Anchor program, a slim Foundry contract, and a unified publisher service.

**Architecture:** Worker emits typed `PublicationRequest` messages to Redpanda `publication.requests`. A new `apps/publisher` service consumes these, posts to Solana (Ed25519-verified pull oracle) and Base (authority-gated per-feed push) in parallel, then records tx hashes in ClickHouse via `pub_status_rev` row insertion. On-chain contracts are publication-only — latest value per feed, no business logic.

**Tech Stack:** Anchor (Rust, Solana), Foundry (Solidity, Base/EVM), TypeScript (publisher service), `@coral-xyz/anchor`, `@solana/web3.js`, `viem`, KafkaJS, ClickHouse, Vitest

**Convention:** All `reportTimestamp` values are **milliseconds since epoch** (`Date.getTime()`), on all chains and in ClickHouse. This is explicit in contract comments, TypeScript code, and test data.

**Spec:** `docs/specs/2026-03-12-agent-economy-oracle-plan2b-on-chain-publication-design.md`

---

## File Structure

### New files

```
packages/core/src/types/publication.ts   — PublicationRequest type + value encoding helpers
migrations/clickhouse/004_published_feed_values_v2.sql — drop+recreate with pub_status_rev

contracts/base/foundry.toml
contracts/base/src/LucidOracle.sol
contracts/base/test/LucidOracle.t.sol

contracts/solana/Anchor.toml
contracts/solana/Cargo.toml
contracts/solana/programs/lucid-oracle/Cargo.toml
contracts/solana/programs/lucid-oracle/src/lib.rs
contracts/solana/programs/lucid-oracle/src/state.rs
contracts/solana/programs/lucid-oracle/src/errors.rs
contracts/solana/programs/lucid-oracle/src/instructions/mod.rs
contracts/solana/programs/lucid-oracle/src/instructions/initialize_feed.rs
contracts/solana/programs/lucid-oracle/src/instructions/post_report.rs
contracts/solana/programs/lucid-oracle/src/instructions/rotate_authority.rs
contracts/solana/tests/lucid-oracle.ts

apps/publisher/package.json
apps/publisher/tsconfig.json
apps/publisher/src/config.ts
apps/publisher/src/solana.ts
apps/publisher/src/base.ts
apps/publisher/src/status.ts
apps/publisher/src/index.ts
apps/publisher/src/__tests__/base.test.ts
apps/publisher/src/__tests__/solana.test.ts
apps/publisher/src/__tests__/status.test.ts
apps/publisher/src/__tests__/publisher.test.ts
```

### Modified files

```
packages/core/src/types/index.ts         — re-export publication.ts
packages/core/src/clients/clickhouse.ts   — add pub_status_rev to PublishedFeedRow, add queryPublicationStatus(), add insertStatusRevisionRow()
packages/core/src/index.ts               — export PublicationRequest, encodeOnChainValue
apps/worker/src/publisher.ts             — add freshnessMs to FeedComputeResult, use computeConfidence(), publish to TOPICS.PUBLICATION
apps/worker/src/cycle.ts                 — pass freshnessMs through FeedComputeResult
apps/worker/src/__tests__/publisher.test.ts — add tests for confidence + publication request
Dockerfile                               — add publisher target
```

---

## Chunk 1: Core Types + ClickHouse Migration

### Task 1: PublicationRequest Type + Value Encoding

**Files:**
- Create: `packages/core/src/types/publication.ts`
- Modify: `packages/core/src/types/index.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the test for value encoding**

```typescript
// packages/core/src/__tests__/publication.test.ts
import { describe, it, expect } from 'vitest'
import { encodeOnChainValue } from '../types/publication.js'

describe('encodeOnChainValue', () => {
  it('encodes AEGDP value_usd as USD × 10^6', () => {
    const result = encodeOnChainValue('aegdp', 847_000, null)
    expect(result).toEqual({ value: 847_000_000_000n, decimals: 6 })
  })

  it('encodes AAI value_index as integer (decimals=0)', () => {
    const result = encodeOnChainValue('aai', null, 742)
    expect(result).toEqual({ value: 742n, decimals: 0 })
  })

  it('encodes APRI value_index as integer (decimals=0)', () => {
    const result = encodeOnChainValue('apri', null, 3200)
    expect(result).toEqual({ value: 3200n, decimals: 0 })
  })

  it('throws for unknown feed_id', () => {
    expect(() => encodeOnChainValue('unknown' as any, 100, null)).toThrow('Unknown feed_id')
  })

  it('throws when AEGDP has no value_usd', () => {
    expect(() => encodeOnChainValue('aegdp', null, null)).toThrow('AEGDP requires value_usd')
  })

  it('throws when AAI/APRI has no value_index', () => {
    expect(() => encodeOnChainValue('aai', null, null)).toThrow('AAI requires value_index')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/publication.test.ts`
Expected: FAIL — `encodeOnChainValue` not found

- [ ] **Step 3: Create the publication types file**

```typescript
// packages/core/src/types/publication.ts
import type { FeedId } from './feeds.js'

/** Message published to TOPICS.PUBLICATION by the worker.
 *  Typed contract between worker and publisher — deliberately NOT PublishedFeedRow. */
export interface PublicationRequest {
  feed_id: FeedId
  feed_version: number
  computed_at: string // ISO 8601
  revision: number    // 0 = original, 1+ = restatement

  // Value
  value_json: string
  value_usd: number | null
  value_index: number | null

  // Quality
  confidence: number
  completeness: number

  // Provenance
  input_manifest_hash: string
  computation_hash: string
  methodology_version: number

  // Attestation
  signer_set_id: string
  signatures_json: string
}

/** On-chain value encoding: feed-specific scaling to u64 + decimals. */
export interface OnChainValue {
  value: bigint
  decimals: number
}

/** Feed-specific value encoding table.
 *  AEGDP: USD × 10^6 (decimals=6). AAI: index 0-1000 (decimals=0). APRI: bps 0-10000 (decimals=0). */
const ENCODING: Record<FeedId, { decimals: number; field: 'value_usd' | 'value_index' }> = {
  aegdp: { decimals: 6, field: 'value_usd' },
  aai:   { decimals: 0, field: 'value_index' },
  apri:  { decimals: 0, field: 'value_index' },
}

/** Encode a feed value for on-chain storage. */
export function encodeOnChainValue(
  feedId: FeedId,
  valueUsd: number | null,
  valueIndex: number | null,
): OnChainValue {
  const enc = ENCODING[feedId]
  if (!enc) throw new Error(`Unknown feed_id: ${feedId}`)

  const raw = enc.field === 'value_usd' ? valueUsd : valueIndex
  if (raw == null) {
    const label = feedId.toUpperCase()
    throw new Error(`${label} requires ${enc.field}`)
  }

  const scaled = BigInt(Math.round(raw * 10 ** enc.decimals))
  return { value: scaled, decimals: enc.decimals }
}
```

- [ ] **Step 4: Add re-export to types/index.ts**

Add to `packages/core/src/types/index.ts`:

```typescript
export * from './publication.js'
```

- [ ] **Step 5: Add export to barrel index**

Add to `packages/core/src/index.ts` after the existing types export:

```typescript
export { encodeOnChainValue, type PublicationRequest, type OnChainValue } from './types/publication.js'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/publication.test.ts`
Expected: 6 tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types/publication.ts packages/core/src/types/index.ts packages/core/src/index.ts packages/core/src/__tests__/publication.test.ts
git commit -m "feat: add PublicationRequest type + encodeOnChainValue helper"
```

---

### Task 2: ClickHouse Migration — Add pub_status_rev

**Files:**
- Create: `migrations/clickhouse/004_published_feed_values_v2.sql`
- Modify: `packages/core/src/clients/clickhouse.ts`

- [ ] **Step 1: Create the ClickHouse migration**

```sql
-- migrations/clickhouse/004_published_feed_values_v2.sql
-- Plan 2B: Add pub_status_rev column, change ReplacingMergeTree version column.
-- DESTRUCTIVE: drops and recreates published_feed_values.
-- Safe in Plan 2B — no production data exists yet.

DROP TABLE IF EXISTS published_feed_values;

CREATE TABLE published_feed_values (
  feed_id             LowCardinality(String),
  feed_version        UInt16,
  computed_at         DateTime64(3),
  revision            UInt16 DEFAULT 0,
  pub_status_rev      UInt16 DEFAULT 0,
  value_json          String,
  value_usd           Nullable(Float64),
  value_index         Nullable(Float64),
  confidence          Float32,
  completeness        Float32,
  freshness_ms        UInt32,
  staleness_risk      LowCardinality(String),
  revision_status     LowCardinality(String) DEFAULT 'preliminary',
  methodology_version UInt16,
  input_manifest_hash String,
  computation_hash    String,
  signer_set_id       String,
  signatures_json     String,
  source_coverage     String,
  published_solana    Nullable(String),
  published_base      Nullable(String)
) ENGINE = ReplacingMergeTree(pub_status_rev)
ORDER BY (feed_id, feed_version, computed_at);
```

- [ ] **Step 2: Update PublishedFeedRow to include pub_status_rev**

In `packages/core/src/clients/clickhouse.ts`, add `pub_status_rev` to the `PublishedFeedRow` interface (after the `revision` field, line 46):

Change:
```typescript
export interface PublishedFeedRow {
  feed_id: string
  feed_version: number
  computed_at: string
  revision: number
  value_json: string
```

To:
```typescript
export interface PublishedFeedRow {
  feed_id: string
  feed_version: number
  computed_at: string
  revision: number
  pub_status_rev: number
  value_json: string
```

- [ ] **Step 3: Add queryPublicationStatus method**

Add this method to the `OracleClickHouse` class in `packages/core/src/clients/clickhouse.ts` (before the `close()` method):

```typescript
  /** Check publication status for a specific feed value (idempotency check).
   *  Returns pub_status_rev so callers can increment it for the next status row. */
  async queryPublicationStatus(
    feedId: string,
    feedVersion: number,
    computedAt: string,
    revision: number,
  ): Promise<{ published_solana: string | null; published_base: string | null; pub_status_rev: number } | null> {
    const result = await this.client.query({
      query: `
        SELECT published_solana, published_base, pub_status_rev
        FROM published_feed_values FINAL
        WHERE feed_id = {feedId:String}
          AND feed_version = {feedVersion:UInt16}
          AND computed_at = {computedAt:String}
          AND revision = {revision:UInt16}
        ORDER BY pub_status_rev DESC
        LIMIT 1
      `,
      query_params: { feedId, feedVersion, computedAt, revision },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ published_solana: string | null; published_base: string | null; pub_status_rev: number }>
    return rows[0] ?? null
  }

  /** Insert a publication-status revision row (pub_status_rev > 0). */
  async insertStatusRevisionRow(
    original: PublishedFeedRow,
    publishedSolana: string | null,
    publishedBase: string | null,
  ): Promise<void> {
    const row: PublishedFeedRow = {
      ...original,
      pub_status_rev: original.pub_status_rev + 1,
      published_solana: publishedSolana,
      published_base: publishedBase,
    }
    await this.client.insert({
      table: 'published_feed_values',
      values: [row],
      format: 'JSONEachRow',
    })
  }
```

- [ ] **Step 4: Update barrel exports**

Add to `packages/core/src/index.ts` (update the existing ClickHouse export line):

```typescript
export {
  OracleClickHouse,
  type ClickHouseConfig,
  type WindowAggregates,
  type ProtocolUsdRow,
  type ProviderCountRow,
  type PublishedFeedRow,
} from './clients/clickhouse.js'
```

No change needed — `PublishedFeedRow` is already exported. The new methods are on `OracleClickHouse` which is also already exported.

- [ ] **Step 5: Update worker publisher to set pub_status_rev = 0**

In `apps/worker/src/publisher.ts`, add `pub_status_rev: 0,` to the `PublishedFeedRow` construction (after the `revision: 0,` line, around line 74):

Change:
```typescript
  const row: PublishedFeedRow = {
    feed_id: result.feedId,
    feed_version: def.version,
    computed_at: now.toISOString(),
    revision: 0,
    value_json: result.valueJson,
```

To:
```typescript
  const row: PublishedFeedRow = {
    feed_id: result.feedId,
    feed_version: def.version,
    computed_at: now.toISOString(),
    revision: 0,
    pub_status_rev: 0,
    value_json: result.valueJson,
```

- [ ] **Step 6: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests PASS (the migration is DDL only — no test changes needed for schema)

- [ ] **Step 7: Commit**

```bash
git add migrations/clickhouse/004_published_feed_values_v2.sql packages/core/src/clients/clickhouse.ts apps/worker/src/publisher.ts
git commit -m "feat: add pub_status_rev column + ClickHouse migration + query methods"
```

---

### Task 3: Worker — Real Confidence + PublicationRequest Publish

**Files:**
- Modify: `apps/worker/src/publisher.ts`
- Modify: `apps/worker/src/cycle.ts`
- Modify: `apps/worker/src/__tests__/publisher.test.ts`

- [ ] **Step 1: Write tests for confidence computation and publication request**

Add to `apps/worker/src/__tests__/publisher.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { shouldPublish, publishFeedValue, type PublishContext, type FeedComputeResult } from '../publisher.js'

// ... (keep existing shouldPublish tests) ...

describe('publishFeedValue', () => {
  it('publishes to both INDEX_UPDATES and PUBLICATION topics', async () => {
    const mockClickhouse = {
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }
    const mockProducer = {
      publishJson: vi.fn().mockResolvedValue(undefined),
    }
    const mockAttestation = {
      signReport: vi.fn().mockReturnValue({
        feed_id: 'aegdp',
        feed_version: 1,
        report_timestamp: 1710288000000,
        values: {},
        input_manifest_hash: 'abc',
        computation_hash: 'def',
        revision: 0,
        signer_set_id: 'ss_lucid_v1',
        signatures: [{ signer: 'pub1', sig: 'sig1' }],
      }),
    }
    const result: FeedComputeResult = {
      feedId: 'aegdp',
      valueJson: '{"value_usd": 1000}',
      valueUsd: 1000,
      valueIndex: null,
      inputManifestHash: 'abc',
      computationHash: 'def',
      completeness: 0.8,
      freshnessMs: 2000,
    }
    const config = {
      heartbeatIntervalMs: 900_000,
    } as any

    await publishFeedValue(result, mockAttestation as any, mockClickhouse as any, mockProducer as any, config)

    // Should publish to both topics
    expect(mockProducer.publishJson).toHaveBeenCalledTimes(2)
    expect(mockProducer.publishJson).toHaveBeenCalledWith('index.updates', 'aegdp', expect.any(Object))
    expect(mockProducer.publishJson).toHaveBeenCalledWith('publication.requests', 'aegdp', expect.any(Object))

    // Verify confidence is NOT just completeness
    const pubRequest = mockProducer.publishJson.mock.calls[1][2]
    expect(pubRequest.confidence).toBeGreaterThan(0)
    expect(pubRequest.feed_id).toBe('aegdp')
    expect(pubRequest.revision).toBe(0)
    expect(pubRequest.methodology_version).toBe(1)
    expect(pubRequest.signer_set_id).toBe('ss_lucid_v1')
  })

  it('uses computeConfidence not raw completeness', async () => {
    const mockClickhouse = { insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined) }
    const mockProducer = { publishJson: vi.fn().mockResolvedValue(undefined) }
    const mockAttestation = {
      signReport: vi.fn().mockReturnValue({
        feed_id: 'aai', feed_version: 1, report_timestamp: Date.now(),
        values: {}, input_manifest_hash: 'a', computation_hash: 'b', revision: 0,
        signer_set_id: 'ss_lucid_v1', signatures: [{ signer: 'p', sig: 's' }],
      }),
    }
    const result: FeedComputeResult = {
      feedId: 'aai', valueJson: '{}', valueUsd: null, valueIndex: 500,
      inputManifestHash: 'a', computationHash: 'b', completeness: 0.5, freshnessMs: 60_000,
    }
    await publishFeedValue(result, mockAttestation as any, mockClickhouse as any, mockProducer as any, { heartbeatIntervalMs: 900_000 } as any)

    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    // confidence should differ from completeness because freshness decays
    // With completeness=0.5 and freshnessMs=60000 (vs 300000ms interval), freshness_score ≈ 0.82
    // Weighted formula produces a value different from raw 0.5
    expect(row.confidence).not.toBe(row.completeness)
    expect(row.pub_status_rev).toBe(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/worker/src/__tests__/publisher.test.ts`
Expected: FAIL — `freshnessMs` not in `FeedComputeResult`, `publishFeedValue` doesn't publish to PUBLICATION

- [ ] **Step 3: Update FeedComputeResult and publishFeedValue**

Replace the full content of `apps/worker/src/publisher.ts`:

```typescript
import {
  AttestationService,
  type ReportPayload,
  type ReportEnvelope,
  type PublishedFeedRow,
  type OracleClickHouse,
  type PublicationRequest,
  RedpandaProducer,
  TOPICS,
  V1_FEEDS,
  type FeedId,
  computeConfidence,
  computeFreshnessScore,
  computeStalenessRisk,
} from '@lucid/oracle-core'
import type { WorkerConfig } from './config.js'

export interface PublishContext {
  feedId: string
  newValue: number
  previousValue: number | null
  thresholdBps: number
  lastPublishedAt: number | null
  heartbeatIntervalMs: number
  now: number
}

/** Determine if a feed value should be published. */
export function shouldPublish(ctx: PublishContext): boolean {
  if (ctx.previousValue === null || ctx.lastPublishedAt === null) return true
  if (ctx.now - ctx.lastPublishedAt >= ctx.heartbeatIntervalMs) return true
  const deviation = Math.abs(ctx.newValue - ctx.previousValue) / Math.max(ctx.previousValue, 1) * 10000
  return deviation > ctx.thresholdBps
}

export interface FeedComputeResult {
  feedId: FeedId
  valueJson: string
  valueUsd: number | null
  valueIndex: number | null
  inputManifestHash: string
  computationHash: string
  completeness: number
  freshnessMs: number
}

/** Attest, persist to ClickHouse, publish to INDEX_UPDATES + PUBLICATION. */
export async function publishFeedValue(
  result: FeedComputeResult,
  attestation: AttestationService,
  clickhouse: OracleClickHouse,
  producer: RedpandaProducer,
  config: WorkerConfig,
): Promise<void> {
  const now = new Date()
  const def = V1_FEEDS[result.feedId]

  // Compute real confidence using the versioned formula
  const confidence = computeConfidence({
    source_diversity_score: result.completeness,
    identity_confidence: 1.0,
    data_completeness: result.completeness,
    anomaly_cleanliness: 1.0,
    freshness_score: computeFreshnessScore(result.freshnessMs, def.update_interval_ms),
    revision_stability: 1.0,
  })

  const payload: ReportPayload = {
    feed_id: result.feedId,
    feed_version: def.version,
    report_timestamp: now.getTime(),
    values: JSON.parse(result.valueJson),
    input_manifest_hash: result.inputManifestHash,
    computation_hash: result.computationHash,
    revision: 0,
  }

  const envelope: ReportEnvelope = attestation.signReport(payload)

  const row: PublishedFeedRow = {
    feed_id: result.feedId,
    feed_version: def.version,
    computed_at: now.toISOString(),
    revision: 0,
    pub_status_rev: 0,
    value_json: result.valueJson,
    value_usd: result.valueUsd,
    value_index: result.valueIndex,
    confidence,
    completeness: result.completeness,
    freshness_ms: result.freshnessMs,
    staleness_risk: computeStalenessRisk(result.freshnessMs, def.update_interval_ms),
    revision_status: 'preliminary',
    methodology_version: def.version,
    input_manifest_hash: result.inputManifestHash,
    computation_hash: result.computationHash,
    signer_set_id: envelope.signer_set_id,
    signatures_json: JSON.stringify(envelope.signatures),
    source_coverage: JSON.stringify(['lucid_gateway']),
    published_solana: null,
    published_base: null,
  }

  // Persist to ClickHouse (source of truth)
  await clickhouse.insertPublishedFeedValue(row)

  // Fanout to API cache
  await producer.publishJson(TOPICS.INDEX_UPDATES, result.feedId, row)

  // Fanout to publisher service for on-chain posting
  const publicationRequest: PublicationRequest = {
    feed_id: result.feedId,
    feed_version: def.version,
    computed_at: now.toISOString(),
    revision: 0,
    value_json: result.valueJson,
    value_usd: result.valueUsd,
    value_index: result.valueIndex,
    confidence,
    completeness: result.completeness,
    input_manifest_hash: result.inputManifestHash,
    computation_hash: result.computationHash,
    methodology_version: def.version,
    signer_set_id: envelope.signer_set_id,
    signatures_json: JSON.stringify(envelope.signatures),
  }

  await producer.publishJson(TOPICS.PUBLICATION, result.feedId, publicationRequest)
}
```

- [ ] **Step 4: Update cycle.ts to pass freshnessMs**

In `apps/worker/src/cycle.ts`, update the three `FeedComputeResult` objects (around lines 84-112) to include `freshnessMs`. The freshness is the age of the computation window boundary:

Change each `FeedComputeResult` to add `freshnessMs: now - to.getTime(),` — but since `to = new Date(now)`, freshness is 0 at computation time. In Plan 2B, set `freshnessMs: 0` (the data was just computed). This matches the Plan 2A pattern where `freshness_ms: 0` was hardcoded. Real window-boundary freshness tracking is deferred.

In each of the three result objects in the `feedResults` array, add:

```typescript
      freshnessMs: 0,
```

After the `completeness` line. For example, the first one becomes:

```typescript
    {
      feedId: 'aegdp',
      valueJson: JSON.stringify({ value_usd: aegdpResult.value_usd, breakdown: aegdpResult.breakdown }),
      valueUsd: aegdpResult.value_usd,
      valueIndex: null,
      inputManifestHash: aegdpResult.input_manifest_hash,
      computationHash: aegdpResult.computation_hash,
      completeness,
      freshnessMs: 0,
    },
```

Repeat for `aai` and `apri` results.

- [ ] **Step 5: Run tests**

Run: `npx vitest run`
Expected: All tests PASS including new publisher tests

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/publisher.ts apps/worker/src/cycle.ts apps/worker/src/__tests__/publisher.test.ts
git commit -m "feat: real computeConfidence + PublicationRequest publish in worker"
```

---

## Chunk 2: Base Foundry Contract

### Task 4: Foundry Project Scaffold

**Files:**
- Create: `contracts/base/foundry.toml`

- [ ] **Step 1: Create contracts/base directory and foundry.toml**

```bash
mkdir -p contracts/base/src contracts/base/test
```

```toml
# contracts/base/foundry.toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.20"
optimizer = true
optimizer_runs = 200

[profile.default.fmt]
line_length = 120
```

- [ ] **Step 2: Install forge-std**

```bash
cd contracts/base && forge install foundry-rs/forge-std --no-commit
```

- [ ] **Step 3: Commit scaffold**

```bash
git add contracts/base/foundry.toml contracts/base/lib
git commit -m "feat: scaffold Foundry project for Base oracle contract"
```

---

### Task 5: LucidOracle.sol Contract

**Files:**
- Create: `contracts/base/src/LucidOracle.sol`

- [ ] **Step 1: Write the contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title LucidOracle — Publication-only oracle for Lucid Agent Economy feeds.
/// @notice Stores the latest report per feed. No business logic — receive signed reports, make them readable.
/// @dev Per-feed postReport (intentional deviation from bundled MVR). See spec for rationale.
contract LucidOracle {
    struct Report {
        uint64 reportTimestamp; // milliseconds since epoch (matches TypeScript Date.getTime())
        uint64 value;           // scaled by decimals
        uint8  decimals;
        uint16 confidence;     // basis points (9700 = 0.97)
        uint16 revision;
        bytes32 inputManifestHash;
        bytes32 computationHash;
    }

    address public authority;
    mapping(bytes16 => Report) public latestReports;

    event ReportPosted(
        bytes16 indexed feedId,
        uint64 value,
        uint64 reportTimestamp,
        uint16 confidence
    );
    event AuthorityRotated(address indexed oldAuthority, address indexed newAuthority);

    error NotAuthority();
    error StaleReport();
    error ZeroAddress();

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority();
        _;
    }

    constructor(address _authority) {
        authority = _authority;
    }

    /// @notice Post a new report for a feed. Enforces lexicographic freshness: newer timestamp wins,
    ///         or same timestamp with higher revision (restatement).
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
        if (
            !(reportTimestamp > current.reportTimestamp ||
              (reportTimestamp == current.reportTimestamp && revision > current.revision))
        ) revert StaleReport();

        latestReports[feedId] = Report(
            reportTimestamp, value, decimals, confidence, revision,
            inputManifestHash, computationHash
        );
        emit ReportPosted(feedId, value, reportTimestamp, confidence);
    }

    /// @notice Get the latest report for a feed.
    function getLatestReport(bytes16 feedId) external view returns (Report memory) {
        return latestReports[feedId];
    }

    /// @notice Transfer authority to a new address.
    function rotateAuthority(address newAuthority) external onlyAuthority {
        if (newAuthority == address(0)) revert ZeroAddress();
        emit AuthorityRotated(authority, newAuthority);
        authority = newAuthority;
    }
}
```

- [ ] **Step 2: Compile**

Run: `cd contracts/base && forge build`
Expected: Compilation succeeds with no errors

- [ ] **Step 3: Commit**

```bash
git add contracts/base/src/LucidOracle.sol
git commit -m "feat: add LucidOracle.sol — per-feed publication-only oracle"
```

---

### Task 6: LucidOracle.t.sol Tests

**Files:**
- Create: `contracts/base/test/LucidOracle.t.sol`

- [ ] **Step 1: Write the test contract**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/LucidOracle.sol";

contract LucidOracleTest is Test {
    LucidOracle oracle;
    address authority = address(this);
    address nonAuthority = address(0xBEEF);
    bytes16 constant AEGDP = bytes16("aegdp");
    bytes16 constant AAI = bytes16("aai");

    function setUp() public {
        oracle = new LucidOracle(authority);
    }

    // --- postReport ---

    // All timestamps are milliseconds since epoch (matching TypeScript Date.getTime())

    function test_postReport_stores_and_emits() public {
        vm.expectEmit(true, false, false, true);
        emit LucidOracle.ReportPosted(AEGDP, 847_000_000_000, 1_710_288_000_000, 9700);

        oracle.postReport(
            AEGDP, 847_000_000_000, 6, 9700, 0, 1_710_288_000_000,
            bytes32(uint256(0xabc)), bytes32(uint256(0xdef))
        );

        LucidOracle.Report memory r = oracle.getLatestReport(AEGDP);
        assertEq(r.value, 847_000_000_000);
        assertEq(r.decimals, 6);
        assertEq(r.confidence, 9700);
        assertEq(r.revision, 0);
        assertEq(r.reportTimestamp, 1_710_288_000_000);
        assertEq(r.inputManifestHash, bytes32(uint256(0xabc)));
        assertEq(r.computationHash, bytes32(uint256(0xdef)));
    }

    function test_postReport_accepts_newer_timestamp() public {
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
        oracle.postReport(AEGDP, 200, 6, 9700, 0, 2_000_000, bytes32(0), bytes32(0));

        LucidOracle.Report memory r = oracle.getLatestReport(AEGDP);
        assertEq(r.value, 200);
        assertEq(r.reportTimestamp, 2_000_000);
    }

    function test_postReport_accepts_same_timestamp_higher_revision() public {
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
        oracle.postReport(AEGDP, 105, 6, 9700, 1, 1_000_000, bytes32(0), bytes32(0));

        LucidOracle.Report memory r = oracle.getLatestReport(AEGDP);
        assertEq(r.value, 105);
        assertEq(r.revision, 1);
    }

    function test_postReport_rejects_stale_timestamp_same_revision() public {
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 2_000_000, bytes32(0), bytes32(0));

        vm.expectRevert(LucidOracle.StaleReport.selector);
        oracle.postReport(AEGDP, 200, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
    }

    function test_postReport_rejects_same_timestamp_same_revision() public {
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));

        vm.expectRevert(LucidOracle.StaleReport.selector);
        oracle.postReport(AEGDP, 200, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
    }

    function test_postReport_rejects_non_authority() public {
        vm.prank(nonAuthority);
        vm.expectRevert(LucidOracle.NotAuthority.selector);
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
    }

    function test_postReport_independent_feeds() public {
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
        oracle.postReport(AAI, 742, 0, 9500, 0, 1_000_000, bytes32(0), bytes32(0));

        assertEq(oracle.getLatestReport(AEGDP).value, 100);
        assertEq(oracle.getLatestReport(AAI).value, 742);
    }

    // --- getLatestReport ---

    function test_getLatestReport_returns_zeroes_for_uninitialized() public view {
        LucidOracle.Report memory r = oracle.getLatestReport(AEGDP);
        assertEq(r.value, 0);
        assertEq(r.reportTimestamp, 0);
    }

    // --- rotateAuthority ---

    function test_rotateAuthority_transfers_and_emits() public {
        address newAuth = address(0x1234);

        vm.expectEmit(true, true, false, false);
        emit LucidOracle.AuthorityRotated(authority, newAuth);

        oracle.rotateAuthority(newAuth);
        assertEq(oracle.authority(), newAuth);
    }

    function test_rotateAuthority_old_authority_rejected() public {
        address newAuth = address(0x1234);
        oracle.rotateAuthority(newAuth);

        vm.expectRevert(LucidOracle.NotAuthority.selector);
        oracle.postReport(AEGDP, 100, 6, 9700, 0, 1_000_000, bytes32(0), bytes32(0));
    }

    function test_rotateAuthority_rejects_zero_address() public {
        vm.expectRevert(LucidOracle.ZeroAddress.selector);
        oracle.rotateAuthority(address(0));
    }

    function test_rotateAuthority_rejects_non_authority() public {
        vm.prank(nonAuthority);
        vm.expectRevert(LucidOracle.NotAuthority.selector);
        oracle.rotateAuthority(address(0x1234));
    }
}
```

- [ ] **Step 2: Run tests**

Run: `cd contracts/base && forge test -vvv`
Expected: All 11 tests PASS

- [ ] **Step 3: Commit**

```bash
git add contracts/base/test/LucidOracle.t.sol
git commit -m "test: add LucidOracle Foundry tests — 11 tests covering all behaviors"
```

---

## Chunk 3: Solana Anchor Program

### Task 7: Anchor Project Scaffold

**Files:**
- Create: `contracts/solana/Anchor.toml`
- Create: `contracts/solana/Cargo.toml`
- Create: `contracts/solana/programs/lucid-oracle/Cargo.toml`

- [ ] **Step 1: Install Anchor CLI (if not present)**

Run: `anchor --version || cargo install --git https://github.com/coral-xyz/anchor avm --force && avm install 0.30.1 && avm use 0.30.1`
Expected: Anchor CLI available

- [ ] **Step 2: Create Anchor workspace scaffold**

```bash
mkdir -p contracts/solana/programs/lucid-oracle/src/instructions
mkdir -p contracts/solana/tests
```

```toml
# contracts/solana/Anchor.toml
[features]
seeds = false
skip-lint = false

[programs.localnet]
lucid_oracle = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[programs.devnet]
lucid_oracle = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "npx ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

```toml
# contracts/solana/Cargo.toml
[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
```

```toml
# contracts/solana/programs/lucid-oracle/Cargo.toml
[package]
name = "lucid-oracle"
version = "0.1.0"
description = "Lucid Agent Economy Oracle — publication-only Solana program"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "lucid_oracle"

[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []

[dependencies]
anchor-lang = "0.30.1"
solana-program = "1.18"
```

- [ ] **Step 3: Commit scaffold**

```bash
git add contracts/solana/Anchor.toml contracts/solana/Cargo.toml contracts/solana/programs/lucid-oracle/Cargo.toml
git commit -m "feat: scaffold Anchor workspace for Solana oracle program"
```

---

### Task 8: Solana State + Errors

**Files:**
- Create: `contracts/solana/programs/lucid-oracle/src/state.rs`
- Create: `contracts/solana/programs/lucid-oracle/src/errors.rs`

- [ ] **Step 1: Write state.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/state.rs
use anchor_lang::prelude::*;

/// Configuration for a single oracle feed.
/// PDA seeds: [b"feed", feed_id]
#[account]
pub struct FeedConfig {
    /// Feed identifier, zero-padded to 16 bytes (e.g., b"aegdp\0\0\0\0\0\0\0\0\0\0\0")
    pub feed_id: [u8; 16],
    /// Schema version for this feed's computation methodology
    pub feed_version: u16,
    /// Authority that can post reports and rotate authority
    pub authority: Pubkey,
    /// Minimum number of signers required (1 at launch)
    pub min_signers: u8,
    /// Authorized Ed25519 signers (max 10)
    pub signer_set: Vec<Pubkey>,
    /// Expected seconds between updates
    pub update_cadence: u32,
    /// PDA bump seed
    pub bump: u8,
}

impl FeedConfig {
    /// Max space: 8 (discriminator) + 16 + 2 + 32 + 1 + 4 + (4 + 32*10) + 4 + 1 = 392
    pub const MAX_SIGNER_SET_LEN: usize = 10;
    pub const SPACE: usize = 8 + 16 + 2 + 32 + 1 + (4 + 32 * Self::MAX_SIGNER_SET_LEN) + 4 + 1;
}

/// Latest report for a single feed.
/// PDA seeds: [b"report", feed_id]
#[account]
pub struct FeedReport {
    /// Feed identifier (matches FeedConfig.feed_id)
    pub feed_id: [u8; 16],
    /// Schema version
    pub feed_version: u16,
    /// Unix timestamp in milliseconds
    /// Milliseconds since epoch (matches TypeScript Date.getTime())
    pub report_timestamp: i64,
    /// Value scaled by decimals
    pub value: u64,
    /// Number of decimal places
    pub decimals: u8,
    /// Confidence in basis points (9700 = 0.97)
    pub confidence: u16,
    /// Computation revision (0 = original, 1+ = restatement)
    pub revision: u16,
    /// SHA-256 of input event set
    pub input_manifest_hash: [u8; 32],
    /// SHA-256 of feed spec code version
    pub computation_hash: [u8; 32],
    /// PDA bump seed
    pub bump: u8,
}

impl FeedReport {
    /// Space: 8 (discriminator) + 16 + 2 + 8 + 8 + 1 + 2 + 2 + 32 + 32 + 1 = 112
    pub const SPACE: usize = 8 + 16 + 2 + 8 + 8 + 1 + 2 + 2 + 32 + 32 + 1;
}
```

- [ ] **Step 2: Write errors.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/errors.rs
use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Report timestamp is stale")]
    StaleReport,
    #[msg("Ed25519 signature verification instruction not found")]
    MissingSigVerify,
    #[msg("Ed25519 signer not in signer_set")]
    UnauthorizedSigner,
    #[msg("Ed25519 message does not match report data")]
    MessageMismatch,
    #[msg("Signer set exceeds maximum length")]
    SignerSetTooLarge,
}
```

- [ ] **Step 3: Commit**

```bash
git add contracts/solana/programs/lucid-oracle/src/state.rs contracts/solana/programs/lucid-oracle/src/errors.rs
git commit -m "feat: add Solana oracle state structs + error codes"
```

---

### Task 9: Solana Instructions — initialize_feed

**Files:**
- Create: `contracts/solana/programs/lucid-oracle/src/instructions/initialize_feed.rs`
- Create: `contracts/solana/programs/lucid-oracle/src/instructions/mod.rs`

- [ ] **Step 1: Write initialize_feed.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/instructions/initialize_feed.rs
use anchor_lang::prelude::*;
use crate::state::{FeedConfig, FeedReport};
use crate::errors::OracleError;

#[derive(Accounts)]
#[instruction(feed_id: [u8; 16])]
pub struct InitializeFeed<'info> {
    #[account(
        init,
        payer = authority,
        space = FeedConfig::SPACE,
        seeds = [b"feed", &feed_id],
        bump,
    )]
    pub feed_config: Account<'info, FeedConfig>,

    #[account(
        init,
        payer = authority,
        space = FeedReport::SPACE,
        seeds = [b"report", &feed_id],
        bump,
    )]
    pub feed_report: Account<'info, FeedReport>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeFeed>,
    feed_id: [u8; 16],
    feed_version: u16,
    update_cadence: u32,
    signer_set: Vec<Pubkey>,
) -> Result<()> {
    require!(
        signer_set.len() <= FeedConfig::MAX_SIGNER_SET_LEN,
        OracleError::SignerSetTooLarge
    );

    let config = &mut ctx.accounts.feed_config;
    config.feed_id = feed_id;
    config.feed_version = feed_version;
    config.authority = ctx.accounts.authority.key();
    config.min_signers = 1;
    config.signer_set = signer_set;
    config.update_cadence = update_cadence;
    config.bump = ctx.bumps.feed_config;

    let report = &mut ctx.accounts.feed_report;
    report.feed_id = feed_id;
    report.feed_version = feed_version;
    report.report_timestamp = 0;
    report.value = 0;
    report.decimals = 0;
    report.confidence = 0;
    report.revision = 0;
    report.input_manifest_hash = [0u8; 32];
    report.computation_hash = [0u8; 32];
    report.bump = ctx.bumps.feed_report;

    Ok(())
}
```

- [ ] **Step 2: Write mod.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/instructions/mod.rs
pub mod initialize_feed;
pub mod post_report;
pub mod rotate_authority;

pub use initialize_feed::*;
pub use post_report::*;
pub use rotate_authority::*;
```

- [ ] **Step 3: Commit**

```bash
git add contracts/solana/programs/lucid-oracle/src/instructions/initialize_feed.rs contracts/solana/programs/lucid-oracle/src/instructions/mod.rs
git commit -m "feat: add initialize_feed instruction"
```

---

### Task 10: Solana Instructions — post_report with Ed25519 Binding

**Files:**
- Create: `contracts/solana/programs/lucid-oracle/src/instructions/post_report.rs`

- [ ] **Step 1: Write post_report.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/instructions/post_report.rs
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use anchor_lang::solana_program::ed25519_program;
use crate::state::{FeedConfig, FeedReport};
use crate::errors::OracleError;

#[derive(Accounts)]
pub struct PostReport<'info> {
    #[account(
        seeds = [b"feed", &feed_config.feed_id],
        bump = feed_config.bump,
        has_one = authority,
    )]
    pub feed_config: Account<'info, FeedConfig>,

    #[account(
        mut,
        seeds = [b"report", &feed_config.feed_id],
        bump = feed_report.bump,
    )]
    pub feed_report: Account<'info, FeedReport>,

    pub authority: Signer<'info>,

    /// CHECK: Instructions sysvar — used to inspect Ed25519SigVerify instruction
    #[account(address = ix_sysvar::ID)]
    pub instructions_sysvar: AccountInfo<'info>,
}

pub fn handler(
    ctx: Context<PostReport>,
    value: u64,
    decimals: u8,
    confidence: u16,
    revision: u16,
    report_timestamp: i64,
    input_manifest_hash: [u8; 32],
    computation_hash: [u8; 32],
) -> Result<()> {
    let report = &mut ctx.accounts.feed_report;
    let config = &ctx.accounts.feed_config;

    // Lexicographic freshness: (timestamp, revision) must be strictly greater
    require!(
        report_timestamp > report.report_timestamp
            || (report_timestamp == report.report_timestamp && revision > report.revision),
        OracleError::StaleReport
    );

    // Build expected message for Ed25519 binding verification
    let expected_message = build_report_message(
        &config.feed_id,
        report_timestamp,
        value,
        decimals,
        confidence,
        revision,
        &input_manifest_hash,
        &computation_hash,
    );

    // Verify Ed25519SigVerify instruction is present with correct signer + message
    verify_ed25519_instruction(
        &ctx.accounts.instructions_sysvar,
        &config.signer_set,
        &expected_message,
    )?;

    // Write report
    report.feed_version = config.feed_version;
    report.report_timestamp = report_timestamp;
    report.value = value;
    report.decimals = decimals;
    report.confidence = confidence;
    report.revision = revision;
    report.input_manifest_hash = input_manifest_hash;
    report.computation_hash = computation_hash;

    Ok(())
}

/// Build the canonical message bytes for Ed25519 verification binding.
/// Fixed-layout concatenation for deterministic on-chain reconstruction.
fn build_report_message(
    feed_id: &[u8; 16],
    report_timestamp: i64,
    value: u64,
    decimals: u8,
    confidence: u16,
    revision: u16,
    input_manifest_hash: &[u8; 32],
    computation_hash: &[u8; 32],
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(16 + 8 + 8 + 1 + 2 + 2 + 32 + 32); // 101 bytes
    msg.extend_from_slice(feed_id);
    msg.extend_from_slice(&report_timestamp.to_le_bytes());
    msg.extend_from_slice(&value.to_le_bytes());
    msg.push(decimals);
    msg.extend_from_slice(&confidence.to_le_bytes());
    msg.extend_from_slice(&revision.to_le_bytes());
    msg.extend_from_slice(input_manifest_hash);
    msg.extend_from_slice(computation_hash);
    msg
}

/// Verify that an Ed25519SigVerify instruction exists in the transaction with:
/// 1. A public key that is in the signer_set
/// 2. A message that matches the expected report message
fn verify_ed25519_instruction(
    instructions_sysvar: &AccountInfo,
    signer_set: &[Pubkey],
    expected_message: &[u8],
) -> Result<()> {
    // Load the current transaction's instruction count
    let num_instructions = ix_sysvar::load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(OracleError::MissingSigVerify))?;

    // Search through all instructions for an Ed25519SigVerify instruction
    for i in 0..num_instructions {
        let ix = ix_sysvar::load_instruction_at_checked(i as usize, instructions_sysvar)
            .map_err(|_| error!(OracleError::MissingSigVerify))?;

        if ix.program_id != ed25519_program::ID {
            continue;
        }

        // Parse the Ed25519 instruction data
        // Format: num_signatures (u8) + padding (u8) + [signature_offset (u16), signature_ix_index (u16),
        //         public_key_offset (u16), public_key_ix_index (u16),
        //         message_data_offset (u16), message_data_size (u16), message_ix_index (u16)]
        if ix.data.len() < 2 {
            continue;
        }

        let num_sigs = ix.data[0] as usize;
        if num_sigs == 0 {
            continue;
        }

        // Parse first signature's offsets (each signature section is 14 bytes after the 2-byte header)
        let offset_base = 2; // after num_signatures + padding
        if ix.data.len() < offset_base + 14 {
            continue;
        }

        let pubkey_offset = u16::from_le_bytes([ix.data[offset_base + 4], ix.data[offset_base + 5]]) as usize;
        let msg_offset = u16::from_le_bytes([ix.data[offset_base + 8], ix.data[offset_base + 9]]) as usize;
        let msg_size = u16::from_le_bytes([ix.data[offset_base + 10], ix.data[offset_base + 11]]) as usize;

        // Extract pubkey (32 bytes)
        if ix.data.len() < pubkey_offset + 32 {
            continue;
        }
        let pubkey_bytes: [u8; 32] = ix.data[pubkey_offset..pubkey_offset + 32]
            .try_into()
            .unwrap();
        let signer_pubkey = Pubkey::from(pubkey_bytes);

        // Check signer is in signer_set
        if !signer_set.contains(&signer_pubkey) {
            return Err(error!(OracleError::UnauthorizedSigner));
        }

        // Extract and verify message
        if ix.data.len() < msg_offset + msg_size {
            continue;
        }
        let msg_bytes = &ix.data[msg_offset..msg_offset + msg_size];

        if msg_bytes != expected_message {
            return Err(error!(OracleError::MessageMismatch));
        }

        // All checks passed
        return Ok(());
    }

    Err(error!(OracleError::MissingSigVerify))
}
```

- [ ] **Step 2: Commit**

```bash
git add contracts/solana/programs/lucid-oracle/src/instructions/post_report.rs
git commit -m "feat: add post_report instruction with bound Ed25519 verification"
```

---

### Task 11: Solana Instructions — rotate_authority + lib.rs

**Files:**
- Create: `contracts/solana/programs/lucid-oracle/src/instructions/rotate_authority.rs`
- Create: `contracts/solana/programs/lucid-oracle/src/lib.rs`

- [ ] **Step 1: Write rotate_authority.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/instructions/rotate_authority.rs
use anchor_lang::prelude::*;
use crate::state::FeedConfig;

#[derive(Accounts)]
pub struct RotateAuthority<'info> {
    #[account(
        mut,
        seeds = [b"feed", &feed_config.feed_id],
        bump = feed_config.bump,
        has_one = authority,
    )]
    pub feed_config: Account<'info, FeedConfig>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<RotateAuthority>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.feed_config.authority = new_authority;
    Ok(())
}
```

- [ ] **Step 2: Write lib.rs**

```rust
// contracts/solana/programs/lucid-oracle/src/lib.rs
use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod lucid_oracle {
    use super::*;

    pub fn initialize_feed(
        ctx: Context<InitializeFeed>,
        feed_id: [u8; 16],
        feed_version: u16,
        update_cadence: u32,
        signer_set: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::initialize_feed::handler(ctx, feed_id, feed_version, update_cadence, signer_set)
    }

    pub fn post_report(
        ctx: Context<PostReport>,
        value: u64,
        decimals: u8,
        confidence: u16,
        revision: u16,
        report_timestamp: i64,
        input_manifest_hash: [u8; 32],
        computation_hash: [u8; 32],
    ) -> Result<()> {
        instructions::post_report::handler(
            ctx, value, decimals, confidence, revision, report_timestamp,
            input_manifest_hash, computation_hash,
        )
    }

    pub fn rotate_authority(ctx: Context<RotateAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::rotate_authority::handler(ctx, new_authority)
    }
}
```

- [ ] **Step 3: Build the program**

Run: `cd contracts/solana && anchor build`
Expected: Build succeeds. Note the program ID from the keypair generated — update `declare_id!` and `Anchor.toml` if needed.

- [ ] **Step 4: Commit**

```bash
git add contracts/solana/programs/lucid-oracle/src/lib.rs contracts/solana/programs/lucid-oracle/src/instructions/rotate_authority.rs
git commit -m "feat: add rotate_authority instruction + lib.rs program entry"
```

---

### Task 12: Solana Anchor Tests

**Files:**
- Create: `contracts/solana/tests/lucid-oracle.ts`
- Create: `contracts/solana/tsconfig.json`

- [ ] **Step 1: Create tsconfig.json for tests**

```json
{
  "compilerOptions": {
    "types": ["mocha", "chai"],
    "typeRoots": ["./node_modules/@types"],
    "lib": ["es2015"],
    "module": "commonjs",
    "target": "es6",
    "esModuleInterop": true
  }
}
```

- [ ] **Step 2: Install test dependencies**

```bash
cd contracts/solana && npm init -y && npm install --save-dev @coral-xyz/anchor @solana/web3.js chai mocha ts-mocha typescript @types/chai @types/mocha
```

- [ ] **Step 3: Write tests**

```typescript
// contracts/solana/tests/lucid-oracle.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LucidOracle } from "../target/types/lucid_oracle";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as ed from "@noble/ed25519";
import { createHash } from "crypto";

// Wire up @noble/ed25519 sha512
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
};

function padFeedId(s: string): number[] {
  const buf = Buffer.alloc(16);
  buf.write(s, "utf8");
  return Array.from(buf);
}

function buildReportMessage(
  feedId: number[],
  reportTimestamp: bigint,
  value: bigint,
  decimals: number,
  confidence: number,
  revision: number,
  inputManifestHash: number[],
  computationHash: number[]
): Buffer {
  const buf = Buffer.alloc(101);
  let offset = 0;
  Buffer.from(feedId).copy(buf, offset); offset += 16;
  buf.writeBigInt64LE(reportTimestamp, offset); offset += 8;
  buf.writeBigUInt64LE(value, offset); offset += 8;
  buf.writeUInt8(decimals, offset); offset += 1;
  buf.writeUInt16LE(confidence, offset); offset += 2;
  buf.writeUInt16LE(revision, offset); offset += 2;
  Buffer.from(inputManifestHash).copy(buf, offset); offset += 32;
  Buffer.from(computationHash).copy(buf, offset);
  return buf;
}

describe("lucid-oracle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LucidOracle as Program<LucidOracle>;

  const feedId = padFeedId("aegdp");
  const feedIdBytes = Buffer.from(feedId);

  // Ed25519 keypair for signing reports
  const signerPrivKey = ed.utils.randomPrivateKey();
  const signerPubKey = ed.getPublicKey(signerPrivKey);
  const signerPubkey = new PublicKey(signerPubKey);

  const zeroHash = new Array(32).fill(0);

  let feedConfigPda: PublicKey;
  let feedReportPda: PublicKey;

  before(async () => {
    [feedConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("feed"), feedIdBytes],
      program.programId
    );
    [feedReportPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("report"), feedIdBytes],
      program.programId
    );
  });

  it("initialize_feed creates PDAs with correct values", async () => {
    await program.methods
      .initializeFeed(feedId, 1, 300, [signerPubkey])
      .accounts({
        feedConfig: feedConfigPda,
        feedReport: feedReportPda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.feedConfig.fetch(feedConfigPda);
    expect(Buffer.from(config.feedId).toString("utf8").replace(/\0/g, "")).to.equal("aegdp");
    expect(config.feedVersion).to.equal(1);
    expect(config.authority.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(config.signerSet).to.have.lengthOf(1);
    expect(config.updateCadence).to.equal(300);
  });

  it("post_report updates FeedReport with correct values", async () => {
    const timestamp = BigInt(Date.now());
    const value = BigInt(847_000_000_000);
    const message = buildReportMessage(feedId, timestamp, value, 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey,
      message,
      signature: sig,
    });

    await program.methods
      .postReport(
        new anchor.BN(value.toString()),
        6, 9700, 0,
        new anchor.BN(timestamp.toString()),
        zeroHash, zeroHash,
      )
      .accounts({
        feedConfig: feedConfigPda,
        feedReport: feedReportPda,
        authority: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .rpc();

    const report = await program.account.feedReport.fetch(feedReportPda);
    expect(report.value.toString()).to.equal(value.toString());
    expect(report.decimals).to.equal(6);
    expect(report.confidence).to.equal(9700);
  });

  it("post_report accepts same timestamp with higher revision", async () => {
    const report = await program.account.feedReport.fetch(feedReportPda);
    const timestamp = BigInt(report.reportTimestamp.toString());
    const value = BigInt(847_100_000_000);
    const message = buildReportMessage(feedId, timestamp, value, 6, 9700, 1, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message, signature: sig,
    });

    await program.methods
      .postReport(new anchor.BN(value.toString()), 6, 9700, 1, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
      .accounts({
        feedConfig: feedConfigPda, feedReport: feedReportPda,
        authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .rpc();

    const updated = await program.account.feedReport.fetch(feedReportPda);
    expect(updated.revision).to.equal(1);
  });

  it("post_report rejects stale timestamp + same revision", async () => {
    // Use a timestamp guaranteed to be older than the one already stored
    const staleTimestamp = BigInt(1_000_000); // milliseconds — well before Date.now()
    const message = buildReportMessage(feedId, staleTimestamp, BigInt(100), 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(100), 6, 9700, 0, new anchor.BN(staleTimestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("StaleReport");
    }
  });

  it("post_report rejects wrong authority", async () => {
    const wrongAuth = Keypair.generate();
    // Airdrop SOL to wrong authority for tx fees
    const airdropSig = await provider.connection.requestAirdrop(wrongAuth.publicKey, 1e9);
    await provider.connection.confirmTransaction(airdropSig);

    const timestamp = BigInt(Date.now() + 1000000);
    const message = buildReportMessage(feedId, timestamp, BigInt(100), 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(100), 6, 9700, 0, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: wrongAuth.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([wrongAuth])
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("has_one");
    }
  });

  it("post_report rejects Ed25519 instruction with wrong signer", async () => {
    // Sign with a key NOT in signer_set
    const wrongPrivKey = ed.utils.randomPrivateKey();
    const wrongPubKey = ed.getPublicKey(wrongPrivKey);

    const timestamp = BigInt(Date.now() + 5000000);
    const value = BigInt(900_000_000_000);
    const message = buildReportMessage(feedId, timestamp, value, 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, wrongPrivKey); // signed by wrong key

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: wrongPubKey, message, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(value.toString()), 6, 9700, 0, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("UnauthorizedSigner");
    }
  });

  it("post_report rejects Ed25519 instruction with wrong message", async () => {
    // Sign a DIFFERENT message than what the report arguments produce
    const timestamp = BigInt(Date.now() + 6000000);
    const value = BigInt(900_000_000_000);
    const wrongValue = BigInt(123); // different from what we'll pass to post_report
    const wrongMessage = buildReportMessage(feedId, timestamp, wrongValue, 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(wrongMessage, signerPrivKey); // correct signer, wrong message

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message: wrongMessage, signature: sig,
    });

    try {
      // post_report passes value=900B but ed25519 was verified against value=123
      await program.methods
        .postReport(new anchor.BN(value.toString()), 6, 9700, 0, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("MessageMismatch");
    }
  });

  it("rotate_authority transfers authority", async () => {
    const newAuth = Keypair.generate();

    await program.methods
      .rotateAuthority(newAuth.publicKey)
      .accounts({
        feedConfig: feedConfigPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const config = await program.account.feedConfig.fetch(feedConfigPda);
    expect(config.authority.toBase58()).to.equal(newAuth.publicKey.toBase58());

    // Old authority should now be rejected
    try {
      await program.methods
        .rotateAuthority(provider.wallet.publicKey)
        .accounts({
          feedConfig: feedConfigPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("has_one");
    }

    // Restore for subsequent tests
    const airdropSig = await provider.connection.requestAirdrop(newAuth.publicKey, 1e9);
    await provider.connection.confirmTransaction(airdropSig);
    await program.methods
      .rotateAuthority(provider.wallet.publicKey)
      .accounts({ feedConfig: feedConfigPda, authority: newAuth.publicKey })
      .signers([newAuth])
      .rpc();
  });
});
```

- [ ] **Step 4: Run tests**

Run: `cd contracts/solana && anchor test`
Expected: All 8 tests PASS (requires local Solana validator via `solana-test-validator`)

- [ ] **Step 5: Commit**

```bash
git add contracts/solana/tests/ contracts/solana/tsconfig.json contracts/solana/package.json
git commit -m "test: add Anchor tests for Solana oracle program — 8 tests"
```

---

## Chunk 4: Publisher Service + Dockerfile

### Task 13: Publisher Package Scaffold + Config

**Files:**
- Create: `apps/publisher/package.json`
- Create: `apps/publisher/tsconfig.json`
- Create: `apps/publisher/src/config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@lucid/oracle-publisher",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lucid/oracle-core": "*",
    "@coral-xyz/anchor": "^0.30.1",
    "@solana/web3.js": "^1.95.0",
    "viem": "^2.21.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create config.ts**

```typescript
// apps/publisher/src/config.ts

export interface PublisherConfig {
  redpandaBrokers: string[]
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
  solanaRpcUrl: string
  solanaKeypairPath: string
  solanaProgramId: string
  baseRpcUrl: string
  basePrivateKey: string
  baseContractAddress: string
  consumerGroup: string
}

export function loadConfig(): PublisherConfig {
  const required = (key: string): string => {
    const val = process.env[key]
    if (!val) throw new Error(`Missing required env var: ${key}`)
    return val
  }

  return {
    redpandaBrokers: required('REDPANDA_BROKERS').split(','),
    clickhouseUrl: required('CLICKHOUSE_URL'),
    clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
    clickhousePassword: required('CLICKHOUSE_PASSWORD'),
    solanaRpcUrl: required('SOLANA_RPC_URL'),
    solanaKeypairPath: required('SOLANA_KEYPAIR_PATH'),
    solanaProgramId: required('SOLANA_PROGRAM_ID'),
    baseRpcUrl: required('BASE_RPC_URL'),
    basePrivateKey: required('BASE_PRIVATE_KEY'),
    baseContractAddress: required('BASE_CONTRACT_ADDRESS'),
    consumerGroup: process.env.PUBLISHER_CONSUMER_GROUP ?? 'oracle-publisher',
  }
}
```

- [ ] **Step 4: Run npm install from root**

```bash
npm install
```

- [ ] **Step 5: Commit**

```bash
git add apps/publisher/package.json apps/publisher/tsconfig.json apps/publisher/src/config.ts
git commit -m "feat: scaffold publisher service package + config"
```

---

### Task 14: Publisher — Base Chain Posting

**Files:**
- Create: `apps/publisher/src/base.ts`
- Create: `apps/publisher/src/__tests__/base.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/publisher/src/__tests__/base.test.ts
import { describe, it, expect, vi } from 'vitest'
import { postToBase, type BaseClient } from '../base.js'
import type { PublicationRequest } from '@lucid/oracle-core'

const mockRequest: PublicationRequest = {
  feed_id: 'aegdp',
  feed_version: 1,
  computed_at: '2026-03-12T00:00:00.000Z',
  revision: 0,
  value_json: '{"value_usd": 847000}',
  value_usd: 847_000,
  value_index: null,
  confidence: 0.85,
  completeness: 0.8,
  input_manifest_hash: 'abc123',
  computation_hash: 'def456',
  methodology_version: 1,
  signer_set_id: 'ss_lucid_v1',
  signatures_json: '[{"signer":"pub1","sig":"sig1"}]',
}

describe('postToBase', () => {
  it('calls writeContract with correct feed encoding', async () => {
    const mockHash = '0xabc123' as `0x${string}`
    const mockReceipt = { transactionHash: mockHash, status: 'success' as const }
    const client: BaseClient = {
      writeContract: vi.fn().mockResolvedValue(mockHash),
      waitForTransactionReceipt: vi.fn().mockResolvedValue(mockReceipt),
    }

    const txHash = await postToBase(client, mockRequest)

    expect(txHash).toBe(mockHash)
    expect(client.writeContract).toHaveBeenCalledOnce()

    const args = (client.writeContract as any).mock.calls[0][0]
    expect(args.functionName).toBe('postReport')
    // AEGDP: 847000 * 10^6 = 847000000000n
    expect(args.args[1]).toBe(847_000_000_000n) // value
    expect(args.args[2]).toBe(6)                // decimals
  })

  it('retries up to 3 times on failure', async () => {
    const client: BaseClient = {
      writeContract: vi.fn()
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockResolvedValueOnce('0xsuccess' as `0x${string}`),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ transactionHash: '0xsuccess', status: 'success' }),
    }

    const txHash = await postToBase(client, mockRequest)
    expect(txHash).toBe('0xsuccess')
    expect(client.writeContract).toHaveBeenCalledTimes(3)
  })

  it('throws after 3 failed attempts', async () => {
    const client: BaseClient = {
      writeContract: vi.fn().mockRejectedValue(new Error('always fails')),
      waitForTransactionReceipt: vi.fn(),
    }

    await expect(postToBase(client, mockRequest)).rejects.toThrow('always fails')
    expect(client.writeContract).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/publisher/src/__tests__/base.test.ts`
Expected: FAIL — `postToBase` not found

- [ ] **Step 3: Write base.ts**

```typescript
// apps/publisher/src/base.ts
import { encodeOnChainValue, type PublicationRequest, type FeedId } from '@lucid/oracle-core'

// Minimal interface for viem wallet client methods we use (for testability)
export interface BaseClient {
  writeContract(args: {
    address: `0x${string}`
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }): Promise<`0x${string}`>
  waitForTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ transactionHash: `0x${string}`; status: string }>
}

const LUCID_ORACLE_ABI = [
  {
    type: 'function',
    name: 'postReport',
    inputs: [
      { name: 'feedId', type: 'bytes16' },
      { name: 'value', type: 'uint64' },
      { name: 'decimals', type: 'uint8' },
      { name: 'confidence', type: 'uint16' },
      { name: 'revision', type: 'uint16' },
      { name: 'reportTimestamp', type: 'uint64' },
      { name: 'inputManifestHash', type: 'bytes32' },
      { name: 'computationHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

const RETRY_DELAYS = [0, 2000, 4000] // 3 attempts: immediate, 2s, 4s

function feedIdToBytes16(feedId: string): `0x${string}` {
  const hex = Buffer.from(feedId.padEnd(16, '\0')).toString('hex')
  return `0x${hex}` as `0x${string}`
}

function toBytes32(hex: string): `0x${string}` {
  const padded = hex.replace(/^0x/, '').padStart(64, '0')
  return `0x${padded}` as `0x${string}`
}

/** Post a report to the Base LucidOracle contract with 3x exponential backoff retry. */
export async function postToBase(
  client: BaseClient,
  req: PublicationRequest,
  contractAddress?: `0x${string}`,
): Promise<string> {
  const addr = contractAddress ?? (process.env.BASE_CONTRACT_ADDRESS as `0x${string}`)
  const { value, decimals } = encodeOnChainValue(req.feed_id as FeedId, req.value_usd, req.value_index)
  const confidenceBps = Math.round(req.confidence * 10000)
  const timestamp = BigInt(new Date(req.computed_at).getTime()) // milliseconds since epoch

  let lastError: Error | undefined
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt])
    try {
      const hash = await client.writeContract({
        address: addr,
        abi: LUCID_ORACLE_ABI,
        functionName: 'postReport',
        args: [
          feedIdToBytes16(req.feed_id),
          value,
          decimals,
          confidenceBps,
          req.revision,
          timestamp,
          toBytes32(req.input_manifest_hash),
          toBytes32(req.computation_hash),
        ],
      })
      await client.waitForTransactionReceipt({ hash })
      return hash
    } catch (err) {
      lastError = err as Error
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/publisher/src/__tests__/base.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/publisher/src/base.ts apps/publisher/src/__tests__/base.test.ts
git commit -m "feat: add Base chain posting with 3x retry — postToBase()"
```

---

### Task 15: Publisher — Solana Chain Posting

**Files:**
- Create: `apps/publisher/src/solana.ts`
- Create: `apps/publisher/src/__tests__/solana.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/publisher/src/__tests__/solana.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildReportMessage, buildEd25519VerifyInstruction, serializePostReportData } from '../solana.js'

describe('buildReportMessage', () => {
  it('produces 101-byte canonical message', () => {
    const feedId = Buffer.alloc(16)
    feedId.write('aegdp', 'utf8')

    const msg = buildReportMessage(
      feedId,
      BigInt(1710288000000),
      BigInt(847_000_000_000),
      6, 9700, 0,
      Buffer.alloc(32), Buffer.alloc(32),
    )

    expect(msg.length).toBe(101)
    // feed_id is first 16 bytes
    expect(msg.subarray(0, 5).toString('utf8')).toBe('aegdp')
    // timestamp starts at offset 16 (8 bytes LE)
    expect(msg.readBigInt64LE(16)).toBe(BigInt(1710288000000))
    // value at offset 24 (8 bytes LE)
    expect(msg.readBigUInt64LE(24)).toBe(BigInt(847_000_000_000))
    // decimals at offset 32
    expect(msg[32]).toBe(6)
    // confidence at offset 33 (2 bytes LE)
    expect(msg.readUInt16LE(33)).toBe(9700)
    // revision at offset 35 (2 bytes LE)
    expect(msg.readUInt16LE(35)).toBe(0)
  })
})

describe('buildEd25519VerifyInstruction', () => {
  it('creates instruction with correct program ID', () => {
    const ix = buildEd25519VerifyInstruction(
      Buffer.alloc(32), // pubkey
      Buffer.alloc(64), // signature
      Buffer.alloc(101), // message
    )
    expect(ix.programId.toBase58()).toBe('Ed25519SigVerify111111111111111111111111111')
  })
})

describe('serializePostReportData', () => {
  it('produces 101-byte buffer with 8-byte discriminator + 93-byte args', () => {
    const data = serializePostReportData(
      BigInt(847_000_000_000), // value
      6, // decimals
      9700, // confidence
      0, // revision
      BigInt(1710288000000), // reportTimestamp (milliseconds)
      Buffer.alloc(32, 0xab), // inputManifestHash
      Buffer.alloc(32, 0xcd), // computationHash
    )

    expect(data.length).toBe(101) // 8 discriminator + 93 args
    // First 8 bytes are the SHA-256 discriminator of "global:post_report"
    expect(data.subarray(0, 8).length).toBe(8)
    // value at offset 8 (u64 LE)
    expect(data.readBigUInt64LE(8)).toBe(BigInt(847_000_000_000))
    // decimals at offset 16 (u8)
    expect(data[16]).toBe(6)
    // confidence at offset 17 (u16 LE)
    expect(data.readUInt16LE(17)).toBe(9700)
    // revision at offset 19 (u16 LE)
    expect(data.readUInt16LE(19)).toBe(0)
    // report_timestamp at offset 21 (i64 LE)
    expect(data.readBigInt64LE(21)).toBe(BigInt(1710288000000))
    // input_manifest_hash at offset 29 (32 bytes)
    expect(data[29]).toBe(0xab)
    // computation_hash at offset 61 (32 bytes)
    expect(data[61]).toBe(0xcd)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/publisher/src/__tests__/solana.test.ts`
Expected: FAIL — `buildReportMessage` not found

- [ ] **Step 3: Write solana.ts**

```typescript
// apps/publisher/src/solana.ts
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js'
import { encodeOnChainValue, type PublicationRequest, type FeedId } from '@lucid/oracle-core'
import * as ed from '@noble/ed25519'
import { createHash } from 'node:crypto'

// Wire up @noble/ed25519 sha512 for Node.js
ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash('sha512')
  for (const m of msgs) h.update(m)
  return new Uint8Array(h.digest())
}

const RETRY_DELAYS = [0, 2000, 4000]

/** Build the canonical 101-byte report message for Ed25519 signing/verification. */
export function buildReportMessage(
  feedId: Buffer,
  reportTimestamp: bigint,
  value: bigint,
  decimals: number,
  confidence: number,
  revision: number,
  inputManifestHash: Buffer,
  computationHash: Buffer,
): Buffer {
  const buf = Buffer.alloc(101)
  let offset = 0
  feedId.copy(buf, offset); offset += 16
  buf.writeBigInt64LE(reportTimestamp, offset); offset += 8
  buf.writeBigUInt64LE(value, offset); offset += 8
  buf.writeUInt8(decimals, offset); offset += 1
  buf.writeUInt16LE(confidence, offset); offset += 2
  buf.writeUInt16LE(revision, offset); offset += 2
  inputManifestHash.copy(buf, offset); offset += 32
  computationHash.copy(buf, offset)
  return buf
}

/** Create an Ed25519SigVerify instruction for the given pubkey, signature, and message. */
export function buildEd25519VerifyInstruction(
  publicKey: Buffer,
  signature: Buffer,
  message: Buffer,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: new Uint8Array(publicKey),
    message: new Uint8Array(message),
    signature: new Uint8Array(signature),
  })
}

/** Anchor discriminator for `post_report`: first 8 bytes of SHA-256("global:post_report"). */
const POST_REPORT_DISCRIMINATOR = Buffer.from(
  createHash('sha256').update('global:post_report').digest().subarray(0, 8),
)

/** Serialize Anchor instruction data for post_report: discriminator + Borsh args.
 *  Args layout (LE): value(u64) + decimals(u8) + confidence(u16) + revision(u16)
 *  + report_timestamp(i64) + input_manifest_hash([u8;32]) + computation_hash([u8;32])
 *  = 8 + 8 + 1 + 2 + 2 + 8 + 32 + 32 = 93 bytes total (+ 8 discriminator = 101). */
export function serializePostReportData(
  value: bigint,
  decimals: number,
  confidence: number,
  revision: number,
  reportTimestamp: bigint,
  inputManifestHash: Buffer,
  computationHash: Buffer,
): Buffer {
  const buf = Buffer.alloc(8 + 93) // discriminator + args
  let offset = 0
  POST_REPORT_DISCRIMINATOR.copy(buf, offset); offset += 8
  buf.writeBigUInt64LE(value, offset); offset += 8
  buf.writeUInt8(decimals, offset); offset += 1
  buf.writeUInt16LE(confidence, offset); offset += 2
  buf.writeUInt16LE(revision, offset); offset += 2
  buf.writeBigInt64LE(reportTimestamp, offset); offset += 8
  inputManifestHash.copy(buf, offset); offset += 32
  computationHash.copy(buf, offset)
  return buf
}

export interface SolanaClient {
  connection: Connection
  keypair: Keypair
  programId: PublicKey
}

/** Post a report to the Solana LucidOracle program with 3x exponential backoff retry. */
export async function postToSolana(
  client: SolanaClient,
  req: PublicationRequest,
  oracleAttestationKey: Uint8Array, // Ed25519 private key for report signing
): Promise<string> {
  const { value, decimals } = encodeOnChainValue(req.feed_id as FeedId, req.value_usd, req.value_index)
  const confidenceBps = Math.round(req.confidence * 10000)
  const timestamp = BigInt(new Date(req.computed_at).getTime()) // milliseconds since epoch

  const feedIdBuf = Buffer.alloc(16)
  feedIdBuf.write(req.feed_id, 'utf8')

  const inputManifestHash = Buffer.from(req.input_manifest_hash.replace(/^0x/, '').padStart(64, '0'), 'hex')
  const computationHash = Buffer.from(req.computation_hash.replace(/^0x/, '').padStart(64, '0'), 'hex')

  const message = buildReportMessage(
    feedIdBuf, timestamp, value, decimals, confidenceBps, req.revision,
    inputManifestHash, computationHash,
  )

  // Sign the message with the oracle attestation key
  const signature = ed.sign(new Uint8Array(message), oracleAttestationKey)
  const pubKey = ed.getPublicKey(oracleAttestationKey)

  // Build Ed25519SigVerify instruction
  const ed25519Ix = buildEd25519VerifyInstruction(
    Buffer.from(pubKey), Buffer.from(signature), message,
  )

  // Derive PDAs
  const [feedConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('feed'), feedIdBuf], client.programId,
  )
  const [feedReportPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('report'), feedIdBuf], client.programId,
  )

  let lastError: Error | undefined
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt])
    try {
      const { blockhash } = await client.connection.getLatestBlockhash()

      // Build post_report instruction data: 8-byte Anchor discriminator + Borsh-serialized args
      const postReportData = serializePostReportData(
        value, decimals, confidenceBps, req.revision, timestamp,
        inputManifestHash, computationHash,
      )

      const postReportIx = new TransactionInstruction({
        programId: client.programId,
        keys: [
          { pubkey: feedConfigPda, isSigner: false, isWritable: false },
          { pubkey: feedReportPda, isSigner: false, isWritable: true },
          { pubkey: client.keypair.publicKey, isSigner: true, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: postReportData,
      })

      const messageV0 = new TransactionMessage({
        payerKey: client.keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [ed25519Ix, postReportIx],
      }).compileToV0Message()

      const tx = new VersionedTransaction(messageV0)
      tx.sign([client.keypair])

      const txSig = await client.connection.sendTransaction(tx)
      await client.connection.confirmTransaction(txSig, 'confirmed')
      return txSig
    } catch (err) {
      lastError = err as Error
    }
  }
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/publisher/src/__tests__/solana.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/publisher/src/solana.ts apps/publisher/src/__tests__/solana.test.ts
git commit -m "feat: add Solana chain posting with Ed25519 message binding"
```

---

### Task 16: Publisher — Status Revision Row

**Files:**
- Create: `apps/publisher/src/status.ts`
- Create: `apps/publisher/src/__tests__/status.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// apps/publisher/src/__tests__/status.test.ts
import { describe, it, expect, vi } from 'vitest'
import { recordPublicationStatus } from '../status.js'
import type { PublicationRequest } from '@lucid/oracle-core'

const mockReq: PublicationRequest = {
  feed_id: 'aegdp', feed_version: 1,
  computed_at: '2026-03-12T00:00:00.000Z', revision: 0,
  value_json: '{}', value_usd: 1000, value_index: null,
  confidence: 0.85, completeness: 0.8,
  input_manifest_hash: 'abc', computation_hash: 'def',
  methodology_version: 1, signer_set_id: 'ss_lucid_v1', signatures_json: '[]',
}

describe('recordPublicationStatus', () => {
  it('inserts status-revision row when at least one chain succeeds', async () => {
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue(null),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await recordPublicationStatus(
      mockClickhouse as any, mockReq,
      '0xsolana_sig', '0xbase_hash',
    )

    expect(mockClickhouse.insertPublishedFeedValue).toHaveBeenCalledOnce()
    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    expect(row.pub_status_rev).toBe(1)
    expect(row.published_solana).toBe('0xsolana_sig')
    expect(row.published_base).toBe('0xbase_hash')
    expect(row.revision).toBe(0) // computation revision unchanged
  })

  it('does not insert when both chains fail', async () => {
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue(null),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await recordPublicationStatus(mockClickhouse as any, mockReq, null, null)
    expect(mockClickhouse.insertPublishedFeedValue).not.toHaveBeenCalled()
  })

  it('skips chains already published (idempotency) and increments pub_status_rev', async () => {
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue({
        published_solana: '0xalready', published_base: null, pub_status_rev: 1,
      }),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    const result = await recordPublicationStatus(
      mockClickhouse as any, mockReq,
      '0xnew_solana', '0xbase_hash',
    )

    // Should skip Solana (already published) but include Base
    expect(result.skipSolana).toBe(true)
    expect(result.skipBase).toBe(false)
    // pub_status_rev should increment from existing (1 → 2)
    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    expect(row.pub_status_rev).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/publisher/src/__tests__/status.test.ts`
Expected: FAIL — `recordPublicationStatus` not found

- [ ] **Step 3: Write status.ts**

```typescript
// apps/publisher/src/status.ts
import type { OracleClickHouse, PublishedFeedRow, PublicationRequest } from '@lucid/oracle-core'

export interface PublicationStatusResult {
  skipSolana: boolean
  skipBase: boolean
}

/** Check idempotency and record publication status in ClickHouse.
 *  Returns which chains were already published (for skipping in the posting step). */
export async function recordPublicationStatus(
  clickhouse: OracleClickHouse,
  req: PublicationRequest,
  solanaTxHash: string | null,
  baseTxHash: string | null,
): Promise<PublicationStatusResult> {
  // Idempotency check
  const existing = await clickhouse.queryPublicationStatus(
    req.feed_id, req.feed_version, req.computed_at, req.revision,
  )

  const skipSolana = existing?.published_solana != null
  const skipBase = existing?.published_base != null

  const effectiveSolana = skipSolana ? existing!.published_solana : solanaTxHash
  const effectiveBase = skipBase ? existing!.published_base : baseTxHash

  // Only insert if at least one chain has a new result
  if (effectiveSolana == null && effectiveBase == null) {
    return { skipSolana, skipBase }
  }

  const row: PublishedFeedRow = {
    feed_id: req.feed_id,
    feed_version: req.feed_version,
    computed_at: req.computed_at,
    revision: req.revision,
    pub_status_rev: (existing?.pub_status_rev ?? 0) + 1,
    value_json: req.value_json,
    value_usd: req.value_usd,
    value_index: req.value_index,
    confidence: req.confidence,
    completeness: req.completeness,
    freshness_ms: 0,
    staleness_risk: 'low',
    revision_status: 'preliminary',
    methodology_version: req.methodology_version,
    input_manifest_hash: req.input_manifest_hash,
    computation_hash: req.computation_hash,
    signer_set_id: req.signer_set_id,
    signatures_json: req.signatures_json,
    source_coverage: JSON.stringify(['lucid_gateway']),
    published_solana: effectiveSolana,
    published_base: effectiveBase,
  }

  await clickhouse.insertPublishedFeedValue(row)
  return { skipSolana, skipBase }
}

/** Pre-flight idempotency check — returns which chains to skip. */
export async function checkAlreadyPublished(
  clickhouse: OracleClickHouse,
  req: PublicationRequest,
): Promise<PublicationStatusResult> {
  const existing = await clickhouse.queryPublicationStatus(
    req.feed_id, req.feed_version, req.computed_at, req.revision,
  )
  return {
    skipSolana: existing?.published_solana != null,
    skipBase: existing?.published_base != null,
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/publisher/src/__tests__/status.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/publisher/src/status.ts apps/publisher/src/__tests__/status.test.ts
git commit -m "feat: add publication status tracking with idempotency check"
```

---

### Task 17: Publisher — Entry Point + Consumer Loop

**Files:**
- Create: `apps/publisher/src/index.ts`
- Create: `apps/publisher/src/__tests__/publisher.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// apps/publisher/src/__tests__/publisher.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handlePublicationRequest } from '../index.js'
import type { PublicationRequest } from '@lucid/oracle-core'

const mockReq: PublicationRequest = {
  feed_id: 'aegdp', feed_version: 1,
  computed_at: '2026-03-12T00:00:00.000Z', revision: 0,
  value_json: '{"value_usd":1000}', value_usd: 1000, value_index: null,
  confidence: 0.85, completeness: 0.8,
  input_manifest_hash: 'abc', computation_hash: 'def',
  methodology_version: 1, signer_set_id: 'ss_lucid_v1', signatures_json: '[]',
}

describe('handlePublicationRequest', () => {
  it('posts to both chains in parallel and records status', async () => {
    const mockSolana = vi.fn().mockResolvedValue('sol_sig_123')
    const mockBase = vi.fn().mockResolvedValue('0xbase_hash_456')
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue(null),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await handlePublicationRequest(mockReq, {
      postSolana: mockSolana,
      postBase: mockBase,
      clickhouse: mockClickhouse as any,
    })

    expect(mockSolana).toHaveBeenCalledWith(mockReq)
    expect(mockBase).toHaveBeenCalledWith(mockReq)
    expect(mockClickhouse.insertPublishedFeedValue).toHaveBeenCalledOnce()
    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    expect(row.published_solana).toBe('sol_sig_123')
    expect(row.published_base).toBe('0xbase_hash_456')
  })

  it('handles partial failure — one chain fails', async () => {
    const mockSolana = vi.fn().mockRejectedValue(new Error('RPC timeout'))
    const mockBase = vi.fn().mockResolvedValue('0xbase_ok')
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue(null),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await handlePublicationRequest(mockReq, {
      postSolana: mockSolana,
      postBase: mockBase,
      clickhouse: mockClickhouse as any,
    })

    const row = mockClickhouse.insertPublishedFeedValue.mock.calls[0][0]
    expect(row.published_solana).toBeNull()
    expect(row.published_base).toBe('0xbase_ok')
  })

  it('skips already-published chains (idempotency)', async () => {
    const mockSolana = vi.fn()
    const mockBase = vi.fn().mockResolvedValue('0xbase_new')
    const mockClickhouse = {
      queryPublicationStatus: vi.fn().mockResolvedValue({
        published_solana: '0xalready_sol', published_base: null,
      }),
      insertPublishedFeedValue: vi.fn().mockResolvedValue(undefined),
    }

    await handlePublicationRequest(mockReq, {
      postSolana: mockSolana,
      postBase: mockBase,
      clickhouse: mockClickhouse as any,
    })

    // Solana should be skipped
    expect(mockSolana).not.toHaveBeenCalled()
    expect(mockBase).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/publisher/src/__tests__/publisher.test.ts`
Expected: FAIL — `handlePublicationRequest` not found

- [ ] **Step 3: Write index.ts**

```typescript
// apps/publisher/src/index.ts
import {
  OracleClickHouse,
  RedpandaConsumer,
  TOPICS,
  type PublicationRequest,
} from '@lucid/oracle-core'
import { loadConfig } from './config.js'
import { checkAlreadyPublished, recordPublicationStatus } from './status.js'

export interface PublicationHandlers {
  postSolana: (req: PublicationRequest) => Promise<string>
  postBase: (req: PublicationRequest) => Promise<string>
  clickhouse: OracleClickHouse
}

/** Handle a single publication request — post to both chains, record status. */
export async function handlePublicationRequest(
  req: PublicationRequest,
  handlers: PublicationHandlers,
): Promise<void> {
  // Idempotency check
  const alreadyPublished = await checkAlreadyPublished(handlers.clickhouse, req)

  // Post to chains in parallel (skip already-published)
  const [solanaResult, baseResult] = await Promise.allSettled([
    alreadyPublished.skipSolana
      ? Promise.resolve(null)
      : handlers.postSolana(req).catch((err) => {
          console.error(`[publisher] Solana posting failed for ${req.feed_id}:`, err.message)
          return null
        }),
    alreadyPublished.skipBase
      ? Promise.resolve(null)
      : handlers.postBase(req).catch((err) => {
          console.error(`[publisher] Base posting failed for ${req.feed_id}:`, err.message)
          return null
        }),
  ])

  const solanaTxHash = solanaResult.status === 'fulfilled' ? solanaResult.value : null
  const baseTxHash = baseResult.status === 'fulfilled' ? baseResult.value : null

  // Record publication status
  await recordPublicationStatus(handlers.clickhouse, req, solanaTxHash, baseTxHash)
}

/** Main entry point — only runs when executed directly (not imported for testing). */
async function main(): Promise<void> {
  const config = loadConfig()

  const clickhouse = new OracleClickHouse({
    url: config.clickhouseUrl,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
  })

  const consumer = new RedpandaConsumer({
    brokers: config.redpandaBrokers,
    groupId: config.consumerGroup,
  })

  // TODO: Initialize real Solana + Base clients from config
  const handlers: PublicationHandlers = {
    postSolana: async (_req) => { throw new Error('Solana client not configured') },
    postBase: async (_req) => { throw new Error('Base client not configured') },
    clickhouse,
  }

  // Graceful shutdown
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log('[publisher] Shutting down...')
    await consumer.disconnect()
    await clickhouse.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Subscribe and consume
  await consumer.subscribe([TOPICS.PUBLICATION])
  console.log('[publisher] Subscribed to', TOPICS.PUBLICATION)

  await consumer.runRaw(async (_key, value) => {
    if (!value) return
    const req = JSON.parse(value) as PublicationRequest
    console.log(`[publisher] Processing ${req.feed_id} @ ${req.computed_at}`)
    await handlePublicationRequest(req, handlers)
  })
}

// Run if this is the entry point
const isMain = process.argv[1]?.includes('publisher')
if (isMain) {
  main().catch((err) => {
    console.error('[publisher] Fatal error:', err)
    process.exit(1)
  })
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/publisher/src/__tests__/publisher.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/publisher/src/index.ts apps/publisher/src/__tests__/publisher.test.ts
git commit -m "feat: add publisher entry point + consumer loop + handlePublicationRequest"
```

---

### Task 18: Dockerfile — Publisher Target

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add publisher package to COPY and add publisher target**

Update `Dockerfile`:

Change:
```dockerfile
COPY apps/worker/package.json apps/worker/
```

To:
```dockerfile
COPY apps/worker/package.json apps/worker/
COPY apps/publisher/package.json apps/publisher/
```

And add after the `worker` target:

```dockerfile
# Publisher target
FROM base AS publisher
CMD ["npx", "tsx", "apps/publisher/src/index.ts"]
```

- [ ] **Step 2: Verify Docker build**

Run: `docker build --target publisher -t oracle-publisher .`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add Dockerfile
git commit -m "feat: add publisher target to multi-stage Dockerfile"
```

---

### Task 19: Run Full Test Suite

- [ ] **Step 1: Run all TypeScript tests**

Run: `npx vitest run`
Expected: All tests PASS — existing tests + new publication/publisher tests

- [ ] **Step 2: Run Base contract tests (if Foundry available)**

Run: `cd contracts/base && forge test -vvv`
Expected: All 11 tests PASS

- [ ] **Step 3: Run Solana tests (if Anchor available)**

Run: `cd contracts/solana && anchor test`
Expected: All 8 tests PASS

- [ ] **Step 4: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: address test failures from full suite run"
```
