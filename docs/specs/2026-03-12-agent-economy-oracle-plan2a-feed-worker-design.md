# Agent Economy Oracle — Plan 2A: Feed Worker Pipeline

**Scope:** Feed worker orchestration, AAI/APRI feed computation, ClickHouse schema, API cache upgrade. No chain code, no MCP tools, no dashboard, no Redis.

**Phase-level simplification:** For Plan 2A, Redis is deferred; the API runs as a single instance and uses an in-memory latest-value cache hydrated from ClickHouse on startup and updated via `INDEX_UPDATES`. The full Redis hot-cache layer, horizontal API scaling, and SSE fanout ship in Plan 3. This is an intentional scope reduction, not an accidental departure from the global design which specifies `Source Adapters → Redpanda → ClickHouse → Redis` as the production data path.

**Builds on:** Plan 1 (Data Plane + Control Plane Foundation) — types, clients, adapters, services, AEGDP feed, REST API skeleton, control plane migration.

**Architecture:** Approach C+ — poll for ingestion + compute, publish via Redpanda, persist in ClickHouse (source of truth), API subscribes to `INDEX_UPDATES` and serves from in-memory cache with ClickHouse backfill on startup.

**Global spec deviations (intentional):**
- `event_id`: `String` not `UUID` — `computeEventId` produces a SHA-256 hash truncated to UUID format, not a true RFC 4122 UUID. `String` is more accurate.
- `amount`: `String` not `Decimal128(18)` — stored as string for precision safety, matching the TypeScript type. AEGDP computes from `usd_value`, not `amount`.
- `published_solana`/`published_base`: collapsed from `(Bool + tx_hash)` to `Nullable(String)` — null = not published, non-null = tx hash. Simpler for Plan 2A.
- `ORDER BY` keys: optimized for Plan 2A query patterns, not identical to global spec:
  - `raw_economic_events`: `(source, chain, event_type, event_timestamp, event_id)` — global spec uses `(event_timestamp, event_id)`. Our key leads with analytical dimensions for filtered scans matching the MV GROUP BY.
  - `metric_rollups_1m`: `(bucket, source, protocol, chain, event_type)` — matches global spec GROUP BY pattern.
  - `published_feed_values`: `(feed_id, feed_version, computed_at)` — global spec uses `(feed_id, computed_at)`. Added `feed_version` to support multi-version dedup within ReplacingMergeTree.

**Computation window:** All feed computations use a **rolling 1-hour window** (`COMPUTATION_WINDOW_MS`, default 3,600,000ms). The worker queries rollups from `(now - window)` to `now`. This provides enough data density for meaningful metrics while keeping query scope bounded.

---

## 1. Worker Architecture

**New workspace package:** `apps/worker/` (`@lucid/oracle-worker`)

Single long-running TypeScript process with a non-overlapping poll loop (setTimeout after cycle completion, not setInterval). Default interval: 5 minutes (configurable via `POLL_INTERVAL_MS`).

### Poll Cycle

On each tick:

1. **Poll** — Query gateway Postgres tables using durable compound watermarks `(last_seen_ts, last_seen_id)` per table. Fetch rows with lexicographic `(created_at, id) > (checkpoint_ts, checkpoint_id)`. For mutable tables (`gateway_payment_sessions`), use `updated_at` as the watermark column instead of `created_at`. When a payment session is re-fetched due to an `updated_at` change, the worker produces a **new event with a new `event_id`** (deterministic from the current row state). The previous event for the same session remains in ClickHouse as historical record. This is consistent with the append-only correction model — future plans can link these via `corrects_event_id` when settlement data is available.

2. **Transform** — Run through existing `transformReceiptEvent`, `transformAuditLogEntry`, `transformPaymentSession` from `@lucid/oracle-core`.

3. **Ingest** — Bulk insert `RawEconomicEvent[]` into ClickHouse `raw_economic_events`. ClickHouse incremental MVs (`metric_rollups_1m`) update automatically at insert time.

4. **Advance checkpoint** — Update `oracle_worker_checkpoints` in Postgres after successful ClickHouse insert. Worker delivery is at-least-once: crashes before checkpoint advancement can cause re-delivery. This is safe because `raw_economic_events` uses deterministic `event_id` for query-time dedup when needed.

5. **Compute** — Query ClickHouse rollups for the current computation window (`now - COMPUTATION_WINDOW_MS` to `now`) using `-Merge` aggregate functions. Run all 3 feed functions (`computeAEGDP`, `computeAAI`, `computeAPRI`). Each returns a typed result with provenance hashes. **Note:** APRI's `provider_concentration` (HHI) requires per-provider event counts, which the rollup's `uniq` aggregate does not provide. The worker queries `raw_economic_events` directly for HHI computation, while using rollups for all other metrics. This is an acceptable trade-off for Plan 2A; a dedicated per-provider count rollup can be added in v2 if query cost becomes an issue.

6. **Threshold check** — Compare new value against latest published value from ClickHouse `published_feed_values` for the same `feed_id`, same `feed_version`, latest revision where `revision_status != 'superseded'`. In Plan 2A, all publications are `revision_status = 'preliminary'` (no settlement finality), so this filter simply picks the most recent `computed_at` with `revision = 0`. The `superseded` status is reserved for future plans when re-attestation with corrected data replaces an earlier value. Publish only if:
   - **Heartbeat:** No publication for this feed in the last `HEARTBEAT_INTERVAL_MS` (default 15 minutes). This is intentionally longer than `POLL_INTERVAL_MS` (5 minutes): the worker computes every cycle but only publishes on heartbeat if the value hasn't deviated. Proves liveness without flooding downstream consumers.
   - **Deviation:** Value changed by more than threshold (AEGDP: 100bps, AAI: 200bps, APRI: 500bps)

7. **Attest** — Sign changed feed values via `AttestationService.signReport()`. Produces a `ReportEnvelope` with multi-signer-ready structure.

8. **Persist** — Insert attested values into ClickHouse `published_feed_values` (source of truth).

9. **Fanout** — Publish compact `INDEX_UPDATES` events to Redpanda for API consumption.

### Single-Worker Lock

Postgres advisory lock (`pg_try_advisory_lock`) held on a **dedicated `pg.Client` connection** (not the pool). If another instance is already running, the new one exits cleanly. If the dedicated lock connection drops, the worker process exits immediately (fail closed). One global worker lock for Plan 2A.

### Graceful Shutdown

On SIGTERM: complete in-progress cycle, release advisory lock, disconnect ClickHouse/Redpanda/Postgres clients, exit 0.

---

## 2. AAI and APRI Feed Computation

Both feeds are pure functions in `packages/core/src/feeds/`. Deterministic, provenance-hashed, versioned methodology.

**v1 Lucid-native methodology note:** Both feeds are computed from Lucid gateway telemetry only. Sub-metrics requiring identity resolution (`subject_entity_id`), cross-protocol data, or USD-value weighting upgrade to methodology v2 when those data sources ship. Code uses `subject_entity_id ?? subject_raw_id` from day one so the upgrade path is seamless.

### AAI (Agent Activity Index)

`computeAAI(inputs: AAIInputs): AAIResult`

Dimensionless activity index [0, 1000]. Higher = more active economy. Four sub-metrics, equally weighted (0.25 each):

| Sub-metric | Definition | Filter |
|-----------|-----------|--------|
| `active_agents` | Unique `subject_entity_id ?? subject_raw_id` with >= 1 event | `economic_authentic = true` |
| `throughput_per_second` | (`tool_call` + `llm_inference` events) / window duration in seconds | `economic_authentic = true` |
| `authentic_tool_call_volume` | Total `tool_call` events | `economic_authentic = true` |
| `model_provider_diversity` | Distinct `(model_id, provider)` pairs | `economic_authentic = true` |

**v1 note:** `throughput_per_second` and `authentic_tool_call_volume` overlap on tool calls, intentionally overweighting execution throughput in v1. v2 diversifies with `task_complete` events and cross-protocol tx count when those data sources are available.

Normalization: log10-based with **versioned anchor constants** in `AAI_NORMALIZATION` (same pattern as `CONFIDENCE_WEIGHTS`). Each sub-metric is normalized to [0, 1000] using `min(1000, (log10(value + 1) / log10(anchor + 1)) * 1000)`. Anchors are methodology-versioned for reproducibility.

Weights versioned in `AAI_WEIGHTS` constant.

### APRI (Agent Protocol Risk Index)

`computeAPRI(inputs: APRIInputs): APRIResult`

Risk score [0, 10000] basis points. **Higher = more risk.** Four weighted dimensions:

| Dimension | Weight | Definition | Scope |
|----------|--------|-----------|-------|
| `error_rate` | 0.30 | Fraction with `status = 'error'` | `llm_inference` + `tool_call` only |
| `provider_concentration` | 0.25 | HHI across `provider` values (event-count in v1, value-weighted in v2) | `llm_inference` + `tool_call` where `provider IS NOT NULL` |
| `authenticity_ratio` | 0.25 | `1 - (authentic events / total events)` — low authenticity = risk | All events |
| `activity_continuity` | 0.20 | `1 - (active 1-min buckets / total buckets)` — gaps = risk. Computed from `metric_rollups_1m`: count buckets with `event_count > 0` in the window. | All events |

Weights versioned in `APRI_WEIGHTS` constant. Each dimension outputs [0, 10000]. Final APRI = weighted sum.

Both functions return `input_manifest_hash` + `computation_hash` for provenance, following the same pattern as `computeAEGDP`.

---

## 3. ClickHouse Schema

ClickHouse DDL in `migrations/clickhouse/` (applied via startup script or manual step — ClickHouse Cloud does not support traditional migration tooling).

### 3.1 `raw_economic_events` — MergeTree

Append-only event store. Plain `MergeTree` (not Replacing — corrections are new rows with `corrects_event_id`, originals are never mutated).

```sql
CREATE TABLE raw_economic_events (
  event_id            String,
  source              LowCardinality(String),
  source_adapter_ver  UInt16,
  ingestion_type      LowCardinality(String),
  ingestion_ts        DateTime64(3),
  chain               LowCardinality(String),
  block_number        Nullable(UInt64),
  tx_hash             Nullable(String),
  log_index           Nullable(UInt32),
  event_type          LowCardinality(String),
  event_timestamp     DateTime64(3),
  subject_entity_id   Nullable(String),
  subject_raw_id      String,
  subject_id_type     LowCardinality(String),
  counterparty_raw_id Nullable(String),
  protocol            LowCardinality(String),
  amount              Nullable(String),
  currency            Nullable(String),
  usd_value           Nullable(Decimal64(6)),
  tool_name           Nullable(String),
  model_id            Nullable(String),
  provider            Nullable(String),
  duration_ms         Nullable(UInt32),
  status              LowCardinality(String),
  quality_score       Float32,
  economic_authentic  UInt8,
  corrects_event_id   Nullable(String),
  correction_reason   Nullable(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_timestamp)
ORDER BY (source, chain, event_type, event_timestamp, event_id);
```

ORDER BY optimized for analytical queries that filter by `source`/`chain`/`event_type` and scan by time — matching the MV GROUP BY pattern. Idempotency: at-least-once delivery via checkpoint discipline. Deterministic `event_id` enables query-time dedup via `argMax`/grouping when needed.

### 3.2 `metric_rollups_1m` — AggregatingMergeTree

Incremental MV target with proper aggregate function types for merge-correct behavior across insert blocks:

```sql
CREATE TABLE metric_rollups_1m (
  bucket              DateTime,
  source              LowCardinality(String),
  protocol            LowCardinality(String),
  chain               LowCardinality(String),
  event_type          LowCardinality(String),
  event_count         SimpleAggregateFunction(sum, UInt64),
  authentic_count     SimpleAggregateFunction(sum, UInt64),
  total_usd_value     SimpleAggregateFunction(sum, Decimal64(6)),
  success_count       SimpleAggregateFunction(sum, UInt64),
  error_count         SimpleAggregateFunction(sum, UInt64),
  distinct_subjects   AggregateFunction(uniq, String),
  distinct_providers  AggregateFunction(uniq, String),
  distinct_model_provider_pairs AggregateFunction(uniq, Tuple(String, String))
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, source, protocol, chain, event_type);
```

Materialized view using `-State` aggregate functions:

```sql
CREATE MATERIALIZED VIEW metric_rollups_1m_mv TO metric_rollups_1m AS
SELECT
  toStartOfMinute(event_timestamp) AS bucket,
  source, protocol, chain, event_type,
  toUInt64(count()) AS event_count,
  toUInt64(countIf(economic_authentic = 1)) AS authentic_count,
  sumIf(usd_value, usd_value IS NOT NULL) AS total_usd_value,
  toUInt64(countIf(status = 'success')) AS success_count,
  toUInt64(countIf(status = 'error')) AS error_count,
  uniqState(coalesce(subject_entity_id, subject_raw_id, '')) AS distinct_subjects,
  uniqState(coalesce(provider, '')) AS distinct_providers,
  uniqState(tuple(coalesce(model_id, ''), coalesce(provider, '')))
    AS distinct_model_provider_pairs
FROM raw_economic_events
WHERE corrects_event_id IS NULL
GROUP BY bucket, source, protocol, chain, event_type;
```

Queries use `-Merge` functions:

```sql
SELECT
  bucket,
  sum(event_count) AS total_events,
  uniqMerge(distinct_subjects) AS unique_agents,
  uniqMerge(distinct_providers) AS unique_providers
FROM metric_rollups_1m
WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
GROUP BY bucket
ORDER BY bucket;
```

### 3.3 `published_feed_values` — ReplacingMergeTree

Source of truth for attested feed values. Richer schema matching the canonical design model:

```sql
CREATE TABLE published_feed_values (
  feed_id             LowCardinality(String),
  feed_version        UInt16,
  computed_at         DateTime64(3),
  revision            UInt16 DEFAULT 0,
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
) ENGINE = ReplacingMergeTree(revision)
ORDER BY (feed_id, feed_version, computed_at);
```

`revision` is the version column for `ReplacingMergeTree` — rows with the same `(feed_id, feed_version, computed_at)` are deduplicated, keeping the highest `revision`. Chain publication columns (`published_solana`, `published_base`) are unused in Plan 2A, populated in Plan 2B.

### 3.4 Postgres Migration `002_worker_checkpoints.sql`

```sql
CREATE TABLE IF NOT EXISTS oracle_worker_checkpoints (
  source_table     TEXT PRIMARY KEY,
  watermark_column TEXT NOT NULL DEFAULT 'created_at',
  last_seen_ts     TIMESTAMPTZ NOT NULL,
  last_seen_id     TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 4. API Changes

The API server (`apps/api/`) upgrades from Plan 1's direct-push model to a worker-driven cache with ClickHouse backing.

**Plan 2A constraint:** Single API instance only. Horizontal scaling requires shared cache (Redis, Plan 3).

### 4.1 Startup Sequence

```
1. Connect to ClickHouse (via OracleClickHouse from @lucid/oracle-core)
2. Connect Redpanda consumer (via RedpandaConsumer from @lucid/oracle-core)
   — subscribe to INDEX_UPDATES topic
   — consumer group: unique per instance (e.g., oracle-api-{hostname})
3. Backfill: for each feed_id in V1_FEEDS, query published_feed_values:
     SELECT * FROM published_feed_values FINAL
     WHERE feed_id = {id} AND feed_version = {V1_FEEDS[id].version}
     ORDER BY computed_at DESC LIMIT 1
   Populate latestFeedValues Map with the result.
4. Start consumer message processing → updates in-memory Map
5. Reconciliation: re-query ClickHouse for any feed_id where the
   published_feed_values row is newer than what's in the Map
   (closes the race window between steps 3 and 4)
6. Start Fastify listening on :4040
```

### 4.2 INDEX_UPDATES Message Schema

Each Redpanda message on the `INDEX_UPDATES` topic is a JSON object:

```json
{
  "feed_id": "aegdp",
  "feed_version": 1,
  "computed_at": "2026-03-12T12:00:00.000Z",
  "revision": 0,
  "value_json": "{\"value_usd\":847000,\"breakdown\":{...}}",
  "value_usd": 847000.00,
  "value_index": null,
  "confidence": 0.92,
  "completeness": 0.85,
  "freshness_ms": 12000,
  "staleness_risk": "low",
  "revision_status": "preliminary",
  "methodology_version": 1,
  "signer_set_id": "ss_lucid_v1",
  "signatures_json": "[{\"signer\":\"ab12...\",\"sig\":\"cd34...\"}]",
  "input_manifest_hash": "abc123...",
  "computation_hash": "def456...",
  "source_coverage": "[\"lucid_gateway\"]"
}
```

Message key: `feed_id` (ensures ordering per feed). Topic string literal: `INDEX_UPDATES`.

### 4.3 Redpanda INDEX_UPDATES Consumer

Background consumer running alongside Fastify in the same process. On each message: parse the feed update JSON, call internal `updateFeedValue()` to update the in-memory Map. On SIGTERM: consumer and server shut down gracefully together.

### 4.4 Remove External Push Interface

`updateFeedValue()` becomes an internal function (called by the consumer handler). No longer exported from `v1.ts`. `_resetFeedValues()` stays for tests.

### 4.5 No New Endpoints

Same feeds/protocols/reports/methodology surface as Plan 1. The difference: backed by real computed data from the worker pipeline instead of an empty Map.

---

## 5. Housekeeping

### 5.1 Freeze Canonical JSON v1

The `HARD GATE` in `canonical-json.ts` is satisfied: we freeze the current recursive key-sorted JSON as **v1**.

- Update comment: `@frozen v1 — do not modify without signer_set_id version bump`
- Add a golden test that pins exact output for a known input
- Document the format in methodology endpoint response
- RFC 8785 (JCS) evaluation deferred — current format is correct and deterministic

### 5.2 Fix Plan 1 `queryFeedRollup` Bug

The Plan 1 `OracleClickHouse.queryFeedRollup()` method filters by `feed_id`, but the `metric_rollups_1m` table has no `feed_id` column — it groups by `(source, protocol, chain, event_type)`. This method must be refactored to accept rollup dimension filters instead of `feed_id`, or replaced with feed-specific query methods that the worker uses directly.

### 5.3 Spec Sync — Update Stale Feed Descriptions

Plan 1 artifacts still reference old AAI/APRI formulas that were revised during Plan 2A design:

- `packages/core/src/types/feeds.ts` — Update `V1_FEEDS` descriptions for AAI and APRI
- `migrations/001_control_plane.sql` — Stale seed `methodology_json`. Add new migration `003_update_feed_methodology.sql` with updated methodology for AAI/APRI
- `apps/api/src/routes/v1.ts` — Extend methodology endpoint to return feed-specific computation details (weights, sub-metrics, normalization anchors) not just the generic confidence formula

### 5.4 Plan 2A Scope Exception

Documented in this spec header. Repeated here for clarity:

> For Plan 2A, Redis is deferred; the API runs as a single instance and uses an in-memory latest-value cache hydrated from ClickHouse on startup and updated via `INDEX_UPDATES`. The full Redis hot-cache layer, horizontal API scaling, and SSE fanout ship in Plan 3.

---

## Environment Variables (New in Plan 2A)

```bash
# Worker
POLL_INTERVAL_MS=300000          # 5 minutes (default)
COMPUTATION_WINDOW_MS=3600000    # 1 hour rolling window (default)
HEARTBEAT_INTERVAL_MS=900000     # 15 minutes — publish even if no deviation (default)
WORKER_LOCK_ID=1                 # Advisory lock ID

# ClickHouse Cloud (same as Plan 1, now actually used)
CLICKHOUSE_URL=https://your-instance.clickhouse.cloud:8443
CLICKHOUSE_PASSWORD=...

# Redpanda (same as Plan 1, now actually used)
REDPANDA_BROKERS=localhost:9092

# Gateway Postgres (read-only, same Supabase instance)
DATABASE_URL=postgresql://...

# Attestation (same as Plan 1)
ORACLE_ATTESTATION_KEY=<hex-encoded-ed25519-private-key>
```

---

## What Ships

| Component | Deliverable |
|-----------|-------------|
| `apps/worker/` | Poll loop, watermark checkpoints, advisory lock, threshold + heartbeat, ClickHouse ingest, Redpanda fanout |
| `packages/core/src/feeds/aai.ts` | `computeAAI` pure function with versioned weights and normalization |
| `packages/core/src/feeds/apri.ts` | `computeAPRI` pure function with versioned weights |
| `migrations/clickhouse/` | DDL for raw_economic_events, metric_rollups_1m + MV, published_feed_values |
| `migrations/002_worker_checkpoints.sql` | Postgres checkpoint table |
| `migrations/003_update_feed_methodology.sql` | Updated AAI/APRI methodology seed data |
| `apps/api/` (modified) | ClickHouse backfill, Redpanda consumer, remove direct push |
| `packages/core/src/clients/clickhouse.ts` | Refactored `queryFeedRollup` → dimension-filtered rollup queries |
| `packages/core/src/utils/canonical-json.ts` | Frozen v1 + golden test |
| `packages/core/src/types/feeds.ts` | Updated V1_FEEDS descriptions |

## What Does NOT Ship

| Deferred to | Item |
|-------------|------|
| Plan 2B | Solana program, Base contract, on-chain publication |
| Plan 3 | Redis hot cache, SSE fanout, MCP tools, dashboard, auth middleware, tiering |
| Plan 4 | External adapters (Virtuals, Olas, ERC-8004), identity resolution |
