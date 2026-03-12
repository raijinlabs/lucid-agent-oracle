# Plan 2A: Feed Worker Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the full feed pipeline — poll gateway data, compute AEGDP/AAI/APRI feeds, attest values, persist to ClickHouse, and fan out to the API via Redpanda.

**Architecture:** Single long-running worker with non-overlapping poll loop. Polls gateway Postgres tables using compound watermarks, transforms to `RawEconomicEvent`, inserts into ClickHouse (with incremental MVs), computes all three feeds from rollups, applies threshold/heartbeat gating, attests via Ed25519, persists to ClickHouse `published_feed_values`, and fans out via Redpanda `INDEX_UPDATES`. API upgrades from direct-push to Redpanda-consumer-driven in-memory cache with ClickHouse backfill on startup.

**Tech Stack:** TypeScript (ES modules), ClickHouse (AggregatingMergeTree + MVs), Redpanda (KafkaJS), Postgres (pg), Ed25519 (@noble/ed25519), Fastify, Vitest

**Spec:** `docs/specs/2026-03-12-agent-economy-oracle-plan2a-feed-worker-design.md`

---

## File Structure

### New files

```
packages/core/src/feeds/aai.ts              — computeAAI pure function
packages/core/src/feeds/apri.ts             — computeAPRI pure function
packages/core/src/__tests__/aai.test.ts     — AAI unit tests
packages/core/src/__tests__/apri.test.ts    — APRI unit tests
packages/core/src/__tests__/canonical-json.test.ts — golden freeze test

migrations/clickhouse/001_raw_economic_events.sql
migrations/clickhouse/002_metric_rollups_1m.sql
migrations/clickhouse/003_published_feed_values.sql
migrations/002_worker_checkpoints.sql
migrations/003_update_feed_methodology.sql

apps/worker/package.json
apps/worker/tsconfig.json
apps/worker/src/config.ts                   — env var parsing + defaults
apps/worker/src/lock.ts                     — Postgres advisory lock
apps/worker/src/checkpoint.ts               — watermark checkpoint CRUD
apps/worker/src/poller.ts                   — poll gateway tables, transform
apps/worker/src/compute.ts                  — bridge rollup data → feed functions
apps/worker/src/publisher.ts                — threshold + attest + persist + fanout
apps/worker/src/cycle.ts                    — single poll cycle orchestration
apps/worker/src/index.ts                    — entry point + loop + shutdown
apps/worker/src/__tests__/lock.test.ts
apps/worker/src/__tests__/checkpoint.test.ts
apps/worker/src/__tests__/poller.test.ts
apps/worker/src/__tests__/compute.test.ts
apps/worker/src/__tests__/publisher.test.ts
apps/worker/src/__tests__/cycle.test.ts
```

### Modified files

```
packages/core/src/utils/canonical-json.ts   — freeze comment
packages/core/src/types/feeds.ts            — V1_FEEDS descriptions
packages/core/src/clients/clickhouse.ts     — refactor + new query methods
packages/core/src/index.ts                  — barrel exports for AAI, APRI
apps/api/src/server.ts                      — startup: backfill + consumer
apps/api/src/routes/v1.ts                   — internalize updateFeedValue, methodology ext
apps/api/src/__tests__/api.test.ts          — updated tests
Dockerfile                                  — add worker target
```

---

## Chunk 1: Core Pure Functions

### Task 1: Freeze Canonical JSON v1 + Golden Test

**Files:**
- Modify: `packages/core/src/utils/canonical-json.ts`
- Create: `packages/core/src/__tests__/canonical-json.test.ts`

- [ ] **Step 1: Write the golden test**

```typescript
// packages/core/src/__tests__/canonical-json.test.ts
import { describe, it, expect } from 'vitest'
import { canonicalStringify } from '../utils/canonical-json.js'

describe('canonicalStringify', () => {
  it('produces deterministic output for nested objects (golden test — v1 frozen format)', () => {
    const input = {
      z: 1,
      a: [3, 1, { y: true, x: null }],
      m: 'hello',
    }
    // Keys sorted at every level: a, m, z. Inner object: x, y.
    // This exact string is frozen. Changing it breaks attestation signatures.
    expect(canonicalStringify(input)).toBe(
      '{"a":[3,1,{"x":null,"y":true}],"m":"hello","z":1}'
    )
  })

  it('handles primitives', () => {
    expect(canonicalStringify(null)).toBe('null')
    expect(canonicalStringify(42)).toBe('42')
    expect(canonicalStringify('test')).toBe('"test"')
    expect(canonicalStringify(true)).toBe('true')
  })

  it('throws on undefined input (not a valid JSON value)', () => {
    // undefined is not a valid JSON value. Callers must never pass it.
    // This guards against silent provenance hash corruption.
    expect(() => canonicalStringify(undefined)).toThrow()
  })

  it('handles empty structures', () => {
    expect(canonicalStringify({})).toBe('{}')
    expect(canonicalStringify([])).toBe('[]')
  })
})
```

- [ ] **Step 2: Run test — expect partial pass (TDD red phase for undefined guard)**

```bash
npx vitest run packages/core/src/__tests__/canonical-json.test.ts
```

Expected: 3 tests PASS (golden, primitives, empty structures), 1 test FAIL (`throws on undefined input` — guard not yet added). This is intentional TDD: we wrote the failing test first.

- [ ] **Step 3: Add undefined guard + update freeze comment**

Replace the HARD GATE comment in `packages/core/src/utils/canonical-json.ts` and add an undefined guard:

```typescript
/** @frozen v1 — do not modify without signer_set_id version bump.
 *
 *  Recursive key-sorted JSON serialization for deterministic hashing.
 *  This format is locked: changing it breaks signature verification for
 *  all existing attested values. See golden test in canonical-json.test.ts.
 *  RFC 8785 (JCS) evaluation deferred — current format is correct and deterministic. */
export function canonicalStringify(obj: unknown): string {
  if (obj === undefined) throw new Error('canonicalStringify: undefined is not a valid JSON value')
  if (obj === null) return JSON.stringify(obj)
  // ... rest unchanged
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: All tests pass (~28 existing + 4 new canonical-json tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/utils/canonical-json.ts packages/core/src/__tests__/canonical-json.test.ts
git commit -m "feat: freeze canonical JSON v1 + golden test"
```

---

### Task 2: computeAAI Pure Function

**Files:**
- Create: `packages/core/src/feeds/aai.ts`
- Create: `packages/core/src/__tests__/aai.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/aai.test.ts
import { describe, it, expect } from 'vitest'
import { computeAAI, AAI_WEIGHTS, AAI_NORMALIZATION, type AAIInputs } from '../feeds/aai.js'

describe('computeAAI', () => {
  const baseInputs: AAIInputs = {
    active_agents: 50,
    throughput_per_second: 5,
    authentic_tool_call_volume: 5000,
    model_provider_diversity: 25,
    window_seconds: 3600,
  }

  it('returns value in [0, 1000]', () => {
    const result = computeAAI(baseInputs)
    expect(result.value).toBeGreaterThanOrEqual(0)
    expect(result.value).toBeLessThanOrEqual(1000)
  })

  it('uses log10 normalization with anchor constants', () => {
    const result = computeAAI(baseInputs)
    // active_agents=50, anchor=100: log10(51)/log10(101) * 1000 ≈ 852.4
    const expectedAgents = Math.min(1000, (Math.log10(51) / Math.log10(101)) * 1000)
    expect(result.breakdown.active_agents).toBeCloseTo(expectedAgents, 1)
  })

  it('returns zero for empty inputs', () => {
    const empty: AAIInputs = {
      active_agents: 0,
      throughput_per_second: 0,
      authentic_tool_call_volume: 0,
      model_provider_diversity: 0,
      window_seconds: 3600,
    }
    const result = computeAAI(empty)
    expect(result.value).toBe(0)
    expect(result.breakdown.active_agents).toBe(0)
  })

  it('caps sub-metrics at 1000', () => {
    const high: AAIInputs = {
      active_agents: 1_000_000,
      throughput_per_second: 1_000_000,
      authentic_tool_call_volume: 1_000_000_000,
      model_provider_diversity: 1_000_000,
      window_seconds: 3600,
    }
    const result = computeAAI(high)
    expect(result.value).toBe(1000)
    expect(result.breakdown.active_agents).toBe(1000)
  })

  it('produces deterministic provenance hashes', () => {
    const a = computeAAI(baseInputs)
    const b = computeAAI(baseInputs)
    expect(a.input_manifest_hash).toBe(b.input_manifest_hash)
    expect(a.computation_hash).toBe(b.computation_hash)
    expect(a.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('weights sum to 1.0', () => {
    const sum =
      AAI_WEIGHTS.active_agents +
      AAI_WEIGHTS.throughput_per_second +
      AAI_WEIGHTS.authentic_tool_call_volume +
      AAI_WEIGHTS.model_provider_diversity
    expect(sum).toBeCloseTo(1.0, 10)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/core/src/__tests__/aai.test.ts
```

Expected: FAIL — module `../feeds/aai.js` does not exist

- [ ] **Step 3: Implement computeAAI**

```typescript
// packages/core/src/feeds/aai.ts
import { createHash } from 'node:crypto'
import { canonicalStringify } from '../utils/canonical-json.js'

/** Versioned weights for AAI sub-metrics. Sum = 1.0. */
export const AAI_WEIGHTS = {
  version: 1,
  active_agents: 0.25,
  throughput_per_second: 0.25,
  authentic_tool_call_volume: 0.25,
  model_provider_diversity: 0.25,
} as const

/** Versioned normalization anchors — value at which sub-metric hits 1000. */
export const AAI_NORMALIZATION = {
  version: 1,
  active_agents: 100,
  throughput_per_second: 10,
  authentic_tool_call_volume: 10_000,
  model_provider_diversity: 50,
} as const

export interface AAIInputs {
  active_agents: number
  throughput_per_second: number
  authentic_tool_call_volume: number
  model_provider_diversity: number
  window_seconds: number
}

export interface AAIResult {
  value: number
  breakdown: {
    active_agents: number
    throughput_per_second: number
    authentic_tool_call_volume: number
    model_provider_diversity: number
  }
  input_manifest_hash: string
  computation_hash: string
}

/** Hash of this computation's source code version (module-level constant, matching AEGDP pattern) */
const COMPUTATION_HASH = createHash('sha256')
  .update(`aai_v${AAI_WEIGHTS.version}_log10_norm_weighted`)
  .digest('hex')

function normalize(value: number, anchor: number): number {
  if (value <= 0) return 0
  return Math.min(1000, (Math.log10(value + 1) / Math.log10(anchor + 1)) * 1000)
}

/** Deterministic AAI computation. Pure function — no side effects. */
export function computeAAI(inputs: AAIInputs): AAIResult {
  const breakdown = {
    active_agents: normalize(inputs.active_agents, AAI_NORMALIZATION.active_agents),
    throughput_per_second: normalize(inputs.throughput_per_second, AAI_NORMALIZATION.throughput_per_second),
    authentic_tool_call_volume: normalize(inputs.authentic_tool_call_volume, AAI_NORMALIZATION.authentic_tool_call_volume),
    model_provider_diversity: normalize(inputs.model_provider_diversity, AAI_NORMALIZATION.model_provider_diversity),
  }

  const value =
    AAI_WEIGHTS.active_agents * breakdown.active_agents +
    AAI_WEIGHTS.throughput_per_second * breakdown.throughput_per_second +
    AAI_WEIGHTS.authentic_tool_call_volume * breakdown.authentic_tool_call_volume +
    AAI_WEIGHTS.model_provider_diversity * breakdown.model_provider_diversity

  const input_manifest_hash = createHash('sha256')
    .update(canonicalStringify(inputs))
    .digest('hex')

  return { value, breakdown, input_manifest_hash, computation_hash: COMPUTATION_HASH }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/core/src/__tests__/aai.test.ts
```

Expected: 6 tests PASS

- [ ] **Step 5: Add barrel exports**

In `packages/core/src/index.ts`, add after the AEGDP export:

```typescript
export { computeAAI, AAI_WEIGHTS, AAI_NORMALIZATION, type AAIInputs, type AAIResult } from './feeds/aai.js'
```

- [ ] **Step 6: Run all tests + typecheck**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass, zero type errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/feeds/aai.ts packages/core/src/__tests__/aai.test.ts packages/core/src/index.ts
git commit -m "feat: add computeAAI pure function with versioned weights and normalization"
```

---

### Task 3: computeAPRI Pure Function

**Files:**
- Create: `packages/core/src/feeds/apri.ts`
- Create: `packages/core/src/__tests__/apri.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/src/__tests__/apri.test.ts
import { describe, it, expect } from 'vitest'
import { computeAPRI, APRI_WEIGHTS, type APRIInputs } from '../feeds/apri.js'

describe('computeAPRI', () => {
  const baseInputs: APRIInputs = {
    error_count: 10,
    operational_event_count: 1000,
    provider_event_counts: { openai: 600, anthropic: 300, google: 100 },
    authentic_event_count: 950,
    total_event_count: 1000,
    active_buckets: 55,
    total_buckets: 60,
  }

  it('returns value in [0, 10000] basis points', () => {
    const result = computeAPRI(baseInputs)
    expect(result.value).toBeGreaterThanOrEqual(0)
    expect(result.value).toBeLessThanOrEqual(10000)
  })

  it('scales raw fractions to basis points', () => {
    const result = computeAPRI(baseInputs)
    // error_rate raw = 10/1000 = 0.01 → 100 bps
    expect(result.breakdown.error_rate).toBeCloseTo(100, 0)
  })

  it('computes HHI correctly for provider concentration', () => {
    const result = computeAPRI(baseInputs)
    // HHI = (600/1000)^2 + (300/1000)^2 + (100/1000)^2 = 0.36 + 0.09 + 0.01 = 0.46
    expect(result.breakdown.provider_concentration).toBeCloseTo(4600, 0)
  })

  it('HHI uses provider-attributed denominator, not operational_event_count', () => {
    // provider_event_counts sum to 500, but operational_event_count is 1000
    const inputs: APRIInputs = {
      ...baseInputs,
      provider_event_counts: { openai: 400, anthropic: 100 },
      operational_event_count: 1000,
    }
    const result = computeAPRI(inputs)
    // HHI = (400/500)^2 + (100/500)^2 = 0.64 + 0.04 = 0.68
    expect(result.breakdown.provider_concentration).toBeCloseTo(6800, 0)
  })

  it('returns zero risk for zero events (except activity_continuity)', () => {
    const empty: APRIInputs = {
      error_count: 0,
      operational_event_count: 0,
      provider_event_counts: {},
      authentic_event_count: 0,
      total_event_count: 0,
      active_buckets: 0,
      total_buckets: 60,
    }
    const result = computeAPRI(empty)
    expect(result.breakdown.error_rate).toBe(0)
    expect(result.breakdown.provider_concentration).toBe(0)
    expect(result.breakdown.authenticity_ratio).toBe(0)
    // activity_continuity = 1.0 * 10000 = 10000 (all gaps)
    expect(result.breakdown.activity_continuity).toBe(10000)
    // Final = 0.20 * 10000 = 2000
    expect(result.value).toBeCloseTo(2000, 0)
  })

  it('returns maximum risk for worst-case inputs', () => {
    const worst: APRIInputs = {
      error_count: 100,
      operational_event_count: 100,
      provider_event_counts: { single: 100 },
      authentic_event_count: 0,
      total_event_count: 100,
      active_buckets: 0,
      total_buckets: 60,
    }
    const result = computeAPRI(worst)
    // error_rate=1.0, concentration=1.0 (single provider HHI), authenticity=1.0, continuity=1.0
    expect(result.value).toBeCloseTo(10000, 0)
  })

  it('produces deterministic provenance hashes', () => {
    const a = computeAPRI(baseInputs)
    const b = computeAPRI(baseInputs)
    expect(a.input_manifest_hash).toBe(b.input_manifest_hash)
    expect(a.computation_hash).toBe(b.computation_hash)
    expect(a.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('weights sum to 1.0', () => {
    const sum =
      APRI_WEIGHTS.error_rate +
      APRI_WEIGHTS.provider_concentration +
      APRI_WEIGHTS.authenticity_ratio +
      APRI_WEIGHTS.activity_continuity
    expect(sum).toBeCloseTo(1.0, 10)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/core/src/__tests__/apri.test.ts
```

Expected: FAIL — module `../feeds/apri.js` does not exist

- [ ] **Step 3: Implement computeAPRI**

```typescript
// packages/core/src/feeds/apri.ts
import { createHash } from 'node:crypto'
import { canonicalStringify } from '../utils/canonical-json.js'

/** Versioned weights for APRI risk dimensions. Sum = 1.0. */
export const APRI_WEIGHTS = {
  version: 1,
  error_rate: 0.30,
  provider_concentration: 0.25,
  authenticity_ratio: 0.25,
  activity_continuity: 0.20,
} as const

export interface APRIInputs {
  error_count: number
  operational_event_count: number
  provider_event_counts: Record<string, number>
  authentic_event_count: number
  total_event_count: number
  active_buckets: number
  total_buckets: number
}

export interface APRIResult {
  value: number
  breakdown: {
    error_rate: number
    provider_concentration: number
    authenticity_ratio: number
    activity_continuity: number
  }
  input_manifest_hash: string
  computation_hash: string
}

/** Hash of this computation's source code version (module-level constant, matching AEGDP pattern) */
const COMPUTATION_HASH = createHash('sha256')
  .update(`apri_v${APRI_WEIGHTS.version}_hhi_error_auth_continuity`)
  .digest('hex')

/** Herfindahl-Hirschman Index: sum of squared market shares. [0, 1]. */
function computeHHI(providerCounts: Record<string, number>): number {
  const total = Object.values(providerCounts).reduce((sum, c) => sum + c, 0)
  if (total === 0) return 0
  return Object.values(providerCounts).reduce((hhi, count) => {
    const share = count / total
    return hhi + share * share
  }, 0)
}

/** Deterministic APRI computation. Pure function — no side effects.
 *  Higher = more risk. [0, 10000] basis points. */
export function computeAPRI(inputs: APRIInputs): APRIResult {
  const errorRateRaw = inputs.operational_event_count > 0
    ? inputs.error_count / inputs.operational_event_count
    : 0

  const providerConcentrationRaw = computeHHI(inputs.provider_event_counts)

  const authenticityRatioRaw = inputs.total_event_count > 0
    ? 1 - (inputs.authentic_event_count / inputs.total_event_count)
    : 0

  const activityContinuityRaw = inputs.total_buckets > 0
    ? 1 - (inputs.active_buckets / inputs.total_buckets)
    : 0

  const breakdown = {
    error_rate: errorRateRaw * 10000,
    provider_concentration: providerConcentrationRaw * 10000,
    authenticity_ratio: authenticityRatioRaw * 10000,
    activity_continuity: activityContinuityRaw * 10000,
  }

  const value =
    APRI_WEIGHTS.error_rate * breakdown.error_rate +
    APRI_WEIGHTS.provider_concentration * breakdown.provider_concentration +
    APRI_WEIGHTS.authenticity_ratio * breakdown.authenticity_ratio +
    APRI_WEIGHTS.activity_continuity * breakdown.activity_continuity

  const input_manifest_hash = createHash('sha256')
    .update(canonicalStringify(inputs))
    .digest('hex')

  return { value, breakdown, input_manifest_hash, computation_hash: COMPUTATION_HASH }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/core/src/__tests__/apri.test.ts
```

Expected: 8 tests PASS

- [ ] **Step 5: Add barrel exports**

In `packages/core/src/index.ts`, add after the AAI export:

```typescript
export { computeAPRI, APRI_WEIGHTS, type APRIInputs, type APRIResult } from './feeds/apri.js'
```

- [ ] **Step 6: Run all tests + typecheck**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass, zero type errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/feeds/apri.ts packages/core/src/__tests__/apri.test.ts packages/core/src/index.ts
git commit -m "feat: add computeAPRI pure function with HHI, versioned weights, basis-point scaling"
```

---

### Task 4: Update V1_FEEDS Descriptions

**Files:**
- Modify: `packages/core/src/types/feeds.ts`
- Create: `migrations/003_update_feed_methodology.sql`

- [ ] **Step 1: Update V1_FEEDS descriptions**

In `packages/core/src/types/feeds.ts`, replace the `aai` and `apri` entries:

```typescript
  aai: {
    id: 'aai',
    version: 1,
    name: 'Agent Activity Index',
    description: 'Dimensionless activity index [0,1000] from active agents, throughput, authentic tool calls, and model-provider diversity',
    update_interval_ms: 300_000,
    deviation_threshold_bps: 200,
    methodology_url: '/v1/oracle/feeds/aai/methodology',
  },
  apri: {
    id: 'apri',
    version: 1,
    name: 'Agent Protocol Risk Index',
    description: 'Risk score [0,10000] bps from error rate, provider concentration (HHI), authenticity ratio, and activity continuity',
    update_interval_ms: 300_000,
    deviation_threshold_bps: 500,
    methodology_url: '/v1/oracle/feeds/apri/methodology',
  },
```

- [ ] **Step 2: Create methodology migration**

```sql
-- migrations/003_update_feed_methodology.sql
-- Updates AAI and APRI methodology_json to match Plan 2A spec

UPDATE oracle_feed_definitions
SET methodology_json = jsonb_build_object(
  'type', 'activity_index',
  'version', 1,
  'range', jsonb_build_array(0, 1000),
  'sub_metrics', jsonb_build_object(
    'active_agents', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 100),
    'throughput_per_second', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 10),
    'authentic_tool_call_volume', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 10000),
    'model_provider_diversity', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 50)
  ),
  'filter', 'economic_authentic = true'
)
WHERE id = 'aai' AND version = 1;

UPDATE oracle_feed_definitions
SET methodology_json = jsonb_build_object(
  'type', 'risk_index',
  'version', 1,
  'range_bps', jsonb_build_array(0, 10000),
  'dimensions', jsonb_build_object(
    'error_rate', jsonb_build_object('weight', 0.30, 'scope', 'llm_inference + tool_call'),
    'provider_concentration', jsonb_build_object('weight', 0.25, 'method', 'HHI', 'scope', 'provider IS NOT NULL'),
    'authenticity_ratio', jsonb_build_object('weight', 0.25, 'scope', 'all events'),
    'activity_continuity', jsonb_build_object('weight', 0.20, 'scope', 'all events', 'bucket_size_ms', 60000)
  ),
  'scaling', 'raw_fraction * 10000'
)
WHERE id = 'apri' AND version = 1;
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/feeds.ts migrations/003_update_feed_methodology.sql
git commit -m "feat: update V1_FEEDS descriptions + methodology migration for AAI/APRI"
```

---

## Chunk 2: ClickHouse Client & Migrations

### Task 5: Refactor ClickHouse Client

**Files:**
- Modify: `packages/core/src/clients/clickhouse.ts`
- Modify: `packages/core/src/__tests__/clickhouse.test.ts`
- Modify: `packages/core/src/index.ts`

The Plan 1 `queryFeedRollup` method is broken (references non-existent `feed_id` column on `metric_rollups_1m`). Replace it with query methods the worker actually needs:

1. `queryWindowAggregates(from, to)` — global window totals + uniqMerge aggregates
2. `queryProtocolUsdBreakdown(from, to)` — per-protocol per-event-type USD for AEGDP
3. `queryActiveBucketCount(from, to)` — for APRI activity_continuity
4. `queryProviderEventCounts(from, to)` — from raw_economic_events for APRI HHI
5. `queryLatestPublishedValue(feedId, feedVersion)` — with FINAL + revision_status filter
6. `insertPublishedFeedValue(row)` — insert into published_feed_values

- [ ] **Step 1: Write failing tests for new methods**

Add to `packages/core/src/__tests__/clickhouse.test.ts`:

```typescript
describe('queryWindowAggregates', () => {
  it('calls query with correct SQL and DateTime-formatted params', async () => {
    const from = new Date('2026-03-12T00:00:00Z')
    const to = new Date('2026-03-12T01:00:00Z')
    await ch.queryWindowAggregates(from, to)
    expect(mockQuery).toHaveBeenCalledWith(expect.objectContaining({
      query_params: expect.objectContaining({
        from: '2026-03-12 00:00:00',
        to: '2026-03-12 01:00:00',
      }),
    }))
  })

  it('includes uniqMerge for unique_providers', async () => {
    const from = new Date('2026-03-12T00:00:00Z')
    const to = new Date('2026-03-12T01:00:00Z')
    await ch.queryWindowAggregates(from, to)
    const call = mockQuery.mock.calls[0][0]
    expect(call.query).toContain('uniqMerge(distinct_providers)')
  })
})

describe('queryLatestPublishedValue', () => {
  it('uses FINAL and revision_status filter', async () => {
    await ch.queryLatestPublishedValue('aegdp', 1)
    const call = mockQuery.mock.calls[0][0]
    expect(call.query).toContain('FINAL')
    expect(call.query).toContain("revision_status != 'superseded'")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run packages/core/src/__tests__/clickhouse.test.ts
```

Expected: FAIL — methods do not exist

- [ ] **Step 3: Rewrite clickhouse.ts**

Replace the full content of `packages/core/src/clients/clickhouse.ts`:

```typescript
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { RawEconomicEvent } from '../types/events.js'

export interface ClickHouseConfig {
  url: string
  username?: string
  password?: string
  database?: string
}

/** Aggregate totals for the computation window (one row). */
export interface WindowAggregates {
  total_events: number
  total_authentic: number
  total_usd: number
  total_success: number
  total_errors: number
  authentic_operational: number
  authentic_tool_calls: number
  total_operational: number
  operational_errors: number
  unique_agents_authentic: number
  unique_model_provider_pairs_authentic: number
  unique_providers: number
}

/** Per-protocol per-event-type USD breakdown for AEGDP. */
export interface ProtocolUsdRow {
  protocol: string
  event_type: string
  usd_value: number
}

/** Provider event counts for HHI calculation. */
export interface ProviderCountRow {
  provider: string
  cnt: number
}

/** Full published_feed_values row matching ClickHouse schema. */
export interface PublishedFeedRow {
  feed_id: string
  feed_version: number
  computed_at: string
  revision: number
  value_json: string
  value_usd: number | null
  value_index: number | null
  confidence: number
  completeness: number
  freshness_ms: number
  staleness_risk: string
  revision_status: string
  methodology_version: number
  input_manifest_hash: string
  computation_hash: string
  signer_set_id: string
  signatures_json: string
  source_coverage: string
  published_solana: string | null
  published_base: string | null
}

/** Format Date as ClickHouse DateTime string (YYYY-MM-DD HH:MM:SS). */
function toClickHouseDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

export class OracleClickHouse {
  private readonly client: ClickHouseClient

  constructor(config: ClickHouseConfig) {
    this.client = createClient({
      url: config.url,
      username: config.username ?? 'default',
      password: config.password ?? '',
      database: config.database ?? 'oracle_economy',
    })
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.client.ping()
    return result.success
  }

  async insertEvents(events: RawEconomicEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.client.insert({
      table: 'raw_economic_events',
      values: events.map((e) => ({
        ...e,
        ingestion_ts: e.ingestion_ts.toISOString(),
        event_timestamp: e.event_timestamp.toISOString(),
        economic_authentic: e.economic_authentic ? 1 : 0,
      })),
      format: 'JSONEachRow',
    })
  }

  /**
   * Global window aggregates from metric_rollups_1m for AAI/APRI computation.
   *
   * No GROUP BY: we want global totals across all key columns. sum() aggregates
   * SimpleAggregateFunction values, uniqMerge() merges AggregateFunction states.
   * ClickHouse handles partial part merges transparently.
   */
  async queryWindowAggregates(from: Date, to: Date): Promise<WindowAggregates> {
    const result = await this.client.query({
      query: `
        SELECT
          sum(event_count) AS total_events,
          sum(authentic_count) AS total_authentic,
          sum(total_usd_value) AS total_usd,
          sum(success_count) AS total_success,
          sum(error_count) AS total_errors,
          sumIf(authentic_count, event_type IN ('llm_inference', 'tool_call')) AS authentic_operational,
          sumIf(authentic_count, event_type = 'tool_call') AS authentic_tool_calls,
          sumIf(event_count, event_type IN ('llm_inference', 'tool_call')) AS total_operational,
          sumIf(error_count, event_type IN ('llm_inference', 'tool_call')) AS operational_errors,
          uniqMerge(distinct_subjects_authentic) AS unique_agents_authentic,
          uniqMerge(distinct_model_provider_pairs_authentic) AS unique_model_provider_pairs_authentic,
          uniqMerge(distinct_providers) AS unique_providers
        FROM metric_rollups_1m
        WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Record<string, string>[]
    const row = rows[0]
    if (!row) {
      return {
        total_events: 0, total_authentic: 0, total_usd: 0,
        total_success: 0, total_errors: 0, authentic_operational: 0,
        authentic_tool_calls: 0, total_operational: 0, operational_errors: 0,
        unique_agents_authentic: 0, unique_model_provider_pairs_authentic: 0,
        unique_providers: 0,
      }
    }
    return {
      total_events: Number(row.total_events),
      total_authentic: Number(row.total_authentic),
      total_usd: Number(row.total_usd),
      total_success: Number(row.total_success),
      total_errors: Number(row.total_errors),
      authentic_operational: Number(row.authentic_operational),
      authentic_tool_calls: Number(row.authentic_tool_calls),
      total_operational: Number(row.total_operational),
      operational_errors: Number(row.operational_errors),
      unique_agents_authentic: Number(row.unique_agents_authentic),
      unique_model_provider_pairs_authentic: Number(row.unique_model_provider_pairs_authentic),
      unique_providers: Number(row.unique_providers),
    }
  }

  /** Per-protocol per-event-type USD breakdown for AEGDP. */
  async queryProtocolUsdBreakdown(from: Date, to: Date): Promise<ProtocolUsdRow[]> {
    const result = await this.client.query({
      query: `
        SELECT protocol, event_type, sum(total_usd_value) AS usd_value
        FROM metric_rollups_1m
        WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
        GROUP BY protocol, event_type
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ protocol: string; event_type: string; usd_value: string }>
    return rows.map((r) => ({ protocol: r.protocol, event_type: r.event_type, usd_value: Number(r.usd_value) }))
  }

  /** Count of 1-min buckets with at least one event (for APRI activity_continuity). */
  async queryActiveBucketCount(from: Date, to: Date): Promise<number> {
    const result = await this.client.query({
      query: `
        SELECT count() AS active_buckets FROM (
          SELECT bucket
          FROM metric_rollups_1m
          WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
          GROUP BY bucket
          HAVING sum(event_count) > 0
        )
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ active_buckets: string }>
    return Number(rows[0]?.active_buckets ?? 0)
  }

  /** Per-provider event counts from raw events for APRI HHI (not from rollups). */
  async queryProviderEventCounts(from: Date, to: Date): Promise<ProviderCountRow[]> {
    const result = await this.client.query({
      query: `
        SELECT provider, count() AS cnt
        FROM raw_economic_events
        WHERE event_timestamp >= {from:DateTime} AND event_timestamp < {to:DateTime}
          AND event_type IN ('llm_inference', 'tool_call')
          AND provider IS NOT NULL
          AND corrects_event_id IS NULL
        GROUP BY provider
      `,
      query_params: {
        from: toClickHouseDateTime(from),
        to: toClickHouseDateTime(to),
      },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ provider: string; cnt: string }>
    return rows.map((r) => ({ provider: r.provider, cnt: Number(r.cnt) }))
  }

  /** Latest non-superseded published value for a feed. Uses FINAL for dedup. */
  async queryLatestPublishedValue(feedId: string, feedVersion: number): Promise<PublishedFeedRow | null> {
    const result = await this.client.query({
      query: `
        SELECT *
        FROM published_feed_values FINAL
        WHERE feed_id = {feedId:String}
          AND feed_version = {feedVersion:UInt16}
          AND revision_status != 'superseded'
        ORDER BY computed_at DESC
        LIMIT 1
      `,
      query_params: { feedId, feedVersion },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as PublishedFeedRow[]
    return rows[0] ?? null
  }

  /** Insert a published feed value. */
  async insertPublishedFeedValue(row: PublishedFeedRow): Promise<void> {
    await this.client.insert({
      table: 'published_feed_values',
      values: [row],
      format: 'JSONEachRow',
    })
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
```

- [ ] **Step 4: Update tests**

Rewrite `packages/core/src/__tests__/clickhouse.test.ts` to test all new methods with mocks. Verify SQL patterns (FINAL, revision_status, IN clauses, GROUP BY HAVING).

- [ ] **Step 5: Update barrel exports**

In `packages/core/src/index.ts`, update the ClickHouse export:

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

Remove the old `RollupRow` and `StoredFeedValue` exports (no longer exist).

- [ ] **Step 6: Run all tests + typecheck**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass, zero type errors

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/clients/clickhouse.ts packages/core/src/__tests__/clickhouse.test.ts packages/core/src/index.ts
git commit -m "refactor: replace queryFeedRollup with dimension-filtered query methods for Plan 2A"
```

---

### Task 6: ClickHouse DDL Migrations

**Files:**
- Create: `migrations/clickhouse/001_raw_economic_events.sql`
- Create: `migrations/clickhouse/002_metric_rollups_1m.sql`
- Create: `migrations/clickhouse/003_published_feed_values.sql`

- [ ] **Step 1: Create raw_economic_events DDL**

```sql
-- migrations/clickhouse/001_raw_economic_events.sql
CREATE TABLE IF NOT EXISTS raw_economic_events (
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

- [ ] **Step 2: Create metric_rollups_1m DDL + MV**

```sql
-- migrations/clickhouse/002_metric_rollups_1m.sql
CREATE TABLE IF NOT EXISTS metric_rollups_1m (
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
  distinct_subjects_authentic AggregateFunction(uniq, String),
  distinct_providers  AggregateFunction(uniq, String),
  distinct_model_provider_pairs AggregateFunction(uniq, Tuple(String, String)),
  distinct_model_provider_pairs_authentic AggregateFunction(uniq, Tuple(String, String))
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, source, protocol, chain, event_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS metric_rollups_1m_mv TO metric_rollups_1m AS
SELECT
  toStartOfMinute(event_timestamp) AS bucket,
  source, protocol, chain, event_type,
  toUInt64(count()) AS event_count,
  toUInt64(countIf(economic_authentic = 1)) AS authentic_count,
  coalesce(sumIf(assumeNotNull(usd_value), usd_value IS NOT NULL), toDecimal64(0, 6)) AS total_usd_value,
  toUInt64(countIf(status = 'success')) AS success_count,
  toUInt64(countIf(status = 'error')) AS error_count,
  uniqState(coalesce(subject_entity_id, subject_raw_id, '')) AS distinct_subjects,
  uniqStateIf(coalesce(subject_entity_id, subject_raw_id, ''), economic_authentic = 1) AS distinct_subjects_authentic,
  uniqStateIf(assumeNotNull(provider), provider IS NOT NULL) AS distinct_providers,
  uniqStateIf(tuple(assumeNotNull(model_id), assumeNotNull(provider)), model_id IS NOT NULL AND provider IS NOT NULL)
    AS distinct_model_provider_pairs,
  uniqStateIf(tuple(assumeNotNull(model_id), assumeNotNull(provider)), model_id IS NOT NULL AND provider IS NOT NULL AND economic_authentic = 1)
    AS distinct_model_provider_pairs_authentic
FROM raw_economic_events
WHERE corrects_event_id IS NULL
GROUP BY bucket, source, protocol, chain, event_type;
```

- [ ] **Step 3: Create published_feed_values DDL**

```sql
-- migrations/clickhouse/003_published_feed_values.sql
CREATE TABLE IF NOT EXISTS published_feed_values (
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

- [ ] **Step 4: Commit**

```bash
git add migrations/clickhouse/
git commit -m "feat: add ClickHouse DDL — raw_economic_events, metric_rollups_1m + MV, published_feed_values"
```

---

### Task 7: Postgres Migration 002

**Files:**
- Create: `migrations/002_worker_checkpoints.sql`

- [ ] **Step 1: Create migration**

```sql
-- migrations/002_worker_checkpoints.sql
CREATE TABLE IF NOT EXISTS oracle_worker_checkpoints (
  source_table     TEXT PRIMARY KEY,
  watermark_column TEXT NOT NULL DEFAULT 'created_at',
  last_seen_ts     TIMESTAMPTZ NOT NULL,
  last_seen_id     TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO oracle_worker_checkpoints (source_table, watermark_column, last_seen_ts, last_seen_id)
VALUES
  ('receipt_events',          'created_at', '1970-01-01T00:00:00Z', ''),
  ('mcpgate_audit_log',       'created_at', '1970-01-01T00:00:00Z', ''),
  ('gateway_payment_sessions','updated_at',  '1970-01-01T00:00:00Z', '')
ON CONFLICT (source_table) DO NOTHING;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/002_worker_checkpoints.sql
git commit -m "feat: add Postgres migration 002 — worker checkpoint table with seed rows"
```

---

## Chunk 3: Worker Pipeline

### Task 8: Worker Package Scaffold + Config

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/src/config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@lucid/oracle-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@lucid/oracle-core": "workspace:*",
    "pg": "^8.13.0"
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
// apps/worker/src/config.ts

export interface WorkerConfig {
  pollIntervalMs: number
  computationWindowMs: number
  heartbeatIntervalMs: number
  workerLockId: number
  databaseUrl: string
  clickhouseUrl: string
  clickhouseUser: string
  clickhousePassword: string
  redpandaBrokers: string[]
  attestationKey: string
}

export function loadConfig(): WorkerConfig {
  const required = (key: string): string => {
    const val = process.env[key]
    if (!val) throw new Error(`Missing required env var: ${key}`)
    return val
  }

  return {
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10),
    computationWindowMs: parseInt(process.env.COMPUTATION_WINDOW_MS ?? '3600000', 10),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '900000', 10),
    workerLockId: parseInt(process.env.WORKER_LOCK_ID ?? '1', 10),
    databaseUrl: required('DATABASE_URL'),
    clickhouseUrl: required('CLICKHOUSE_URL'),
    clickhouseUser: process.env.CLICKHOUSE_USER ?? 'default',
    clickhousePassword: required('CLICKHOUSE_PASSWORD'),
    redpandaBrokers: required('REDPANDA_BROKERS').split(','),
    attestationKey: required('ORACLE_ATTESTATION_KEY'),
  }
}
```

- [ ] **Step 4: Run npm install from root to register workspace**

```bash
npm install
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```

Expected: Zero errors

- [ ] **Step 6: Commit**

```bash
git add apps/worker/
git commit -m "feat: scaffold apps/worker package with config loader"
```

---

### Task 9: Advisory Lock

**Files:**
- Create: `apps/worker/src/lock.ts`
- Create: `apps/worker/src/__tests__/lock.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/__tests__/lock.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
const mockOn = vi.fn()
const mockEnd = vi.fn()
vi.mock('pg', () => ({
  default: { Client: vi.fn(() => ({ connect: vi.fn(), query: mockQuery, on: mockOn, end: mockEnd })) },
}))

import { acquireAdvisoryLock, releaseAdvisoryLock } from '../lock.js'

describe('advisory lock', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('acquires lock and returns true when available', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: true }] })
    const result = await acquireAdvisoryLock('postgresql://test', 1)
    expect(result).not.toBeNull()
    expect(mockQuery).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1)', [1])
  })

  it('returns null when lock is held', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ pg_try_advisory_lock: false }] })
    const result = await acquireAdvisoryLock('postgresql://test', 1)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run apps/worker/src/__tests__/lock.test.ts
```

Expected: FAIL — module does not exist

- [ ] **Step 3: Implement lock.ts**

```typescript
// apps/worker/src/lock.ts
import pg from 'pg'

const { Client } = pg

export interface LockHandle {
  release: () => Promise<void>
}

/**
 * Acquire a Postgres advisory lock on a dedicated connection.
 * Returns a LockHandle if acquired, null if already held.
 * If the connection drops, calls onLost (default: process.exit(1)).
 */
export async function acquireAdvisoryLock(
  connectionString: string,
  lockId: number,
  onLost?: () => void,
): Promise<LockHandle | null> {
  const client = new Client({ connectionString })
  await client.connect()

  client.on('error', () => {
    console.error('Advisory lock connection lost — exiting')
    ;(onLost ?? (() => process.exit(1)))()
  })

  const result = await client.query('SELECT pg_try_advisory_lock($1)', [lockId])
  const acquired = result.rows[0]?.pg_try_advisory_lock === true

  if (!acquired) {
    await client.end()
    return null
  }

  return {
    release: async () => {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId])
      } finally {
        await client.end()
      }
    },
  }
}

// Re-export for backward compat in tests
export async function releaseAdvisoryLock(handle: LockHandle): Promise<void> {
  await handle.release()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run apps/worker/src/__tests__/lock.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lock.ts apps/worker/src/__tests__/lock.test.ts
git commit -m "feat: add Postgres advisory lock with dedicated connection + fail-closed"
```

---

### Task 10: Checkpoint Manager + Gateway Poller

**Files:**
- Create: `apps/worker/src/checkpoint.ts`
- Create: `apps/worker/src/poller.ts`
- Create: `apps/worker/src/__tests__/checkpoint.test.ts`
- Create: `apps/worker/src/__tests__/poller.test.ts`

- [ ] **Step 1: Write checkpoint test**

```typescript
// apps/worker/src/__tests__/checkpoint.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => ({ query: mockQuery })) },
}))

import { CheckpointManager } from '../checkpoint.js'

describe('CheckpointManager', () => {
  let mgr: CheckpointManager

  beforeEach(() => {
    vi.clearAllMocks()
    mgr = new CheckpointManager('postgresql://test')
  })

  it('loads checkpoints from database', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { source_table: 'receipt_events', watermark_column: 'created_at', last_seen_ts: '2026-01-01T00:00:00Z', last_seen_id: 'abc' },
      ],
    })
    const checkpoints = await mgr.loadAll()
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0].source_table).toBe('receipt_events')
  })

  it('advances checkpoint after successful insert', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await mgr.advance('receipt_events', new Date('2026-03-12T12:00:00Z'), 'id_123')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE oracle_worker_checkpoints'),
      expect.arrayContaining(['receipt_events'])
    )
  })
})
```

- [ ] **Step 2: Write poller test**

```typescript
// apps/worker/src/__tests__/poller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('pg', () => ({
  default: { Pool: vi.fn(() => ({ query: mockQuery })) },
}))

import { pollGatewayTable } from '../poller.js'

describe('pollGatewayTable', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('queries with compound watermark', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const mockPool = { query: mockQuery } as unknown as import('pg').Pool
    await pollGatewayTable(mockPool, {
      source_table: 'receipt_events',
      watermark_column: 'created_at',
      last_seen_ts: '2026-01-01T00:00:00Z',
      last_seen_id: '',
    })
    const sql = mockQuery.mock.calls[0][0]
    expect(sql).toContain('receipt_events')
    expect(sql).toContain('created_at')
    expect(sql).toContain('ORDER BY')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run apps/worker/src/__tests__/checkpoint.test.ts apps/worker/src/__tests__/poller.test.ts
```

Expected: FAIL

- [ ] **Step 4: Implement checkpoint.ts**

```typescript
// apps/worker/src/checkpoint.ts
import pg from 'pg'

const { Pool } = pg

export interface Checkpoint {
  source_table: string
  watermark_column: string
  last_seen_ts: string
  last_seen_id: string
}

export class CheckpointManager {
  private readonly pool: InstanceType<typeof Pool>

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString })
  }

  async loadAll(): Promise<Checkpoint[]> {
    const result = await this.pool.query(
      'SELECT source_table, watermark_column, last_seen_ts, last_seen_id FROM oracle_worker_checkpoints'
    )
    return result.rows.map((r: Record<string, unknown>) => ({
      source_table: r.source_table as string,
      watermark_column: r.watermark_column as string,
      last_seen_ts: (r.last_seen_ts as Date).toISOString(),
      last_seen_id: r.last_seen_id as string,
    }))
  }

  async advance(sourceTable: string, ts: Date, id: string): Promise<void> {
    await this.pool.query(
      'UPDATE oracle_worker_checkpoints SET last_seen_ts = $2, last_seen_id = $3, updated_at = now() WHERE source_table = $1',
      [sourceTable, ts.toISOString(), id]
    )
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
```

- [ ] **Step 5: Implement poller.ts**

```typescript
// apps/worker/src/poller.ts
import type pg from 'pg'
import {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
  type RawEconomicEvent,
} from '@lucid/oracle-core'
import type { Checkpoint } from './checkpoint.js'

/** Poll a single gateway table using compound watermark. Returns new rows transformed to events. */
export async function pollGatewayTable(
  pool: pg.Pool,
  checkpoint: Checkpoint,
): Promise<{ events: RawEconomicEvent[]; lastTs: Date | null; lastId: string | null }> {
  const { source_table, watermark_column, last_seen_ts, last_seen_id } = checkpoint

  const result = await pool.query(
    `SELECT * FROM ${source_table}
     WHERE (${watermark_column}, id) > ($1, $2)
     ORDER BY ${watermark_column}, id
     LIMIT 1000`,
    [last_seen_ts, last_seen_id]
  )

  if (result.rows.length === 0) {
    return { events: [], lastTs: null, lastId: null }
  }

  const events = result.rows.map((row: Record<string, unknown>) => {
    switch (source_table) {
      case 'receipt_events':
        return transformReceiptEvent(row as Parameters<typeof transformReceiptEvent>[0])
      case 'mcpgate_audit_log':
        return transformAuditLogEntry(row as Parameters<typeof transformAuditLogEntry>[0])
      case 'gateway_payment_sessions':
        return transformPaymentSession(row as Parameters<typeof transformPaymentSession>[0])
      default:
        throw new Error(`Unknown source table: ${source_table}`)
    }
  })

  const lastRow = result.rows[result.rows.length - 1]
  const lastTs = new Date(lastRow[watermark_column] as string)
  const lastId = lastRow.id as string

  return { events, lastTs, lastId }
}

/** Poll all gateway tables and return combined events with metadata. */
export async function pollAllTables(
  pool: pg.Pool,
  checkpoints: Checkpoint[],
): Promise<{ events: RawEconomicEvent[]; updates: Array<{ table: string; ts: Date; id: string }> }> {
  const allEvents: RawEconomicEvent[] = []
  const updates: Array<{ table: string; ts: Date; id: string }> = []

  for (const cp of checkpoints) {
    const { events, lastTs, lastId } = await pollGatewayTable(pool, cp)
    allEvents.push(...events)
    if (lastTs && lastId) {
      updates.push({ table: cp.source_table, ts: lastTs, id: lastId })
    }
  }

  return { events: allEvents, updates }
}
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run apps/worker/src/__tests__/checkpoint.test.ts apps/worker/src/__tests__/poller.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/checkpoint.ts apps/worker/src/poller.ts apps/worker/src/__tests__/checkpoint.test.ts apps/worker/src/__tests__/poller.test.ts
git commit -m "feat: add checkpoint manager + gateway table poller with compound watermarks"
```

---

### Task 11: Feed Computation Orchestrator

**Files:**
- Create: `apps/worker/src/compute.ts`
- Create: `apps/worker/src/__tests__/compute.test.ts`

This module bridges ClickHouse query results to the pure feed functions.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/__tests__/compute.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildAEGDPInputs,
  buildAAIInputs,
  buildAPRIInputs,
} from '../compute.js'
import type { ProtocolUsdRow, WindowAggregates, ProviderCountRow } from '@lucid/oracle-core'

describe('buildAEGDPInputs', () => {
  it('groups USD by protocol and event_type', () => {
    const rows: ProtocolUsdRow[] = [
      { protocol: 'lucid', event_type: 'payment', usd_value: 500 },
      { protocol: 'lucid', event_type: 'task_complete', usd_value: 200 },
      { protocol: 'virtuals', event_type: 'revenue_distribute', usd_value: 100 },
    ]
    const inputs = buildAEGDPInputs(rows)
    expect(inputs.protocol_payments_usd.lucid).toBe(500)
    expect(inputs.protocol_task_revenue_usd.lucid).toBe(200)
    expect(inputs.protocol_revenue_distributed_usd.virtuals).toBe(100)
  })
})

describe('buildAAIInputs', () => {
  it('maps window aggregates to AAI inputs', () => {
    const agg: WindowAggregates = {
      total_events: 1000, total_authentic: 900, total_usd: 50000,
      total_success: 950, total_errors: 50,
      authentic_operational: 800, authentic_tool_calls: 400,
      total_operational: 900, operational_errors: 50,
      unique_agents_authentic: 42, unique_model_provider_pairs_authentic: 15,
      unique_providers: 3,
    }
    const inputs = buildAAIInputs(agg, 3600)
    expect(inputs.active_agents).toBe(42)
    expect(inputs.throughput_per_second).toBeCloseTo(800 / 3600, 4)
    expect(inputs.authentic_tool_call_volume).toBe(400)
    expect(inputs.model_provider_diversity).toBe(15)
  })
})

describe('buildAPRIInputs', () => {
  it('maps aggregates + provider counts to APRI inputs', () => {
    const agg: WindowAggregates = {
      total_events: 1000, total_authentic: 950, total_usd: 50000,
      total_success: 950, total_errors: 50,
      authentic_operational: 800, authentic_tool_calls: 400,
      total_operational: 900, operational_errors: 30,
      unique_agents_authentic: 42, unique_model_provider_pairs_authentic: 15,
      unique_providers: 3,
    }
    const providers: ProviderCountRow[] = [
      { provider: 'openai', cnt: 600 },
      { provider: 'anthropic', cnt: 300 },
    ]
    const inputs = buildAPRIInputs(agg, providers, 55, 60)
    expect(inputs.error_count).toBe(30)
    expect(inputs.operational_event_count).toBe(900)
    expect(inputs.provider_event_counts).toEqual({ openai: 600, anthropic: 300 })
    expect(inputs.active_buckets).toBe(55)
    expect(inputs.total_buckets).toBe(60)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run apps/worker/src/__tests__/compute.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement compute.ts**

```typescript
// apps/worker/src/compute.ts
import type {
  AEGDPInputs,
  AAIInputs,
  APRIInputs,
  ProtocolUsdRow,
  WindowAggregates,
  ProviderCountRow,
} from '@lucid/oracle-core'

/** Map per-protocol per-event-type USD rows to AEGDP inputs. */
export function buildAEGDPInputs(rows: ProtocolUsdRow[]): AEGDPInputs {
  const payments: Record<string, number> = {}
  const tasks: Record<string, number> = {}
  const revenue: Record<string, number> = {}

  for (const r of rows) {
    switch (r.event_type) {
      case 'payment':
        payments[r.protocol] = (payments[r.protocol] ?? 0) + r.usd_value
        break
      case 'task_complete':
        tasks[r.protocol] = (tasks[r.protocol] ?? 0) + r.usd_value
        break
      case 'revenue_distribute':
        revenue[r.protocol] = (revenue[r.protocol] ?? 0) + r.usd_value
        break
    }
  }

  return {
    protocol_payments_usd: payments,
    protocol_task_revenue_usd: tasks,
    protocol_revenue_distributed_usd: revenue,
  }
}

/** Map window aggregates to AAI inputs. */
export function buildAAIInputs(agg: WindowAggregates, windowSeconds: number): AAIInputs {
  return {
    active_agents: agg.unique_agents_authentic,
    throughput_per_second: windowSeconds > 0 ? agg.authentic_operational / windowSeconds : 0,
    authentic_tool_call_volume: agg.authentic_tool_calls,
    model_provider_diversity: agg.unique_model_provider_pairs_authentic,
    window_seconds: windowSeconds,
  }
}

/** Map aggregates + raw provider counts to APRI inputs. */
export function buildAPRIInputs(
  agg: WindowAggregates,
  providerCounts: ProviderCountRow[],
  activeBuckets: number,
  totalBuckets: number,
): APRIInputs {
  const providerEventCounts: Record<string, number> = {}
  for (const r of providerCounts) {
    providerEventCounts[r.provider] = r.cnt
  }

  return {
    error_count: agg.operational_errors,
    operational_event_count: agg.total_operational,
    provider_event_counts: providerEventCounts,
    authentic_event_count: agg.total_authentic,
    total_event_count: agg.total_events,
    active_buckets: activeBuckets,
    total_buckets: totalBuckets,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run apps/worker/src/__tests__/compute.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/compute.ts apps/worker/src/__tests__/compute.test.ts
git commit -m "feat: add feed computation bridge — maps ClickHouse rollups to pure function inputs"
```

---

### Task 12: Publisher (Threshold + Attest + Persist + Fanout)

**Files:**
- Create: `apps/worker/src/publisher.ts`
- Create: `apps/worker/src/__tests__/publisher.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/__tests__/publisher.test.ts
import { describe, it, expect } from 'vitest'
import { shouldPublish, type PublishContext } from '../publisher.js'

describe('shouldPublish', () => {
  const base: PublishContext = {
    feedId: 'aegdp',
    newValue: 1000,
    previousValue: 990,
    thresholdBps: 100,
    lastPublishedAt: null,
    heartbeatIntervalMs: 900_000,
    now: Date.now(),
  }

  it('publishes on first computation (no previous)', () => {
    expect(shouldPublish({ ...base, previousValue: null, lastPublishedAt: null })).toBe(true)
  })

  it('publishes when deviation exceeds threshold', () => {
    // |1000 - 990| / max(990, 1) * 10000 = 101 bps > 100 bps
    expect(shouldPublish(base)).toBe(true)
  })

  it('does not publish when deviation is below threshold', () => {
    const recent = Date.now() - 60_000 // 1 min ago — within heartbeat window
    expect(shouldPublish({ ...base, newValue: 990.5, lastPublishedAt: recent })).toBe(false)
  })

  it('publishes on heartbeat even without deviation', () => {
    const old = Date.now() - 1_000_000 // > 15 min ago
    expect(shouldPublish({ ...base, newValue: 990, lastPublishedAt: old })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run apps/worker/src/__tests__/publisher.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement publisher.ts**

```typescript
// apps/worker/src/publisher.ts
import {
  AttestationService,
  type ReportPayload,
  type ReportEnvelope,
  type PublishedFeedRow,
  type OracleClickHouse,
  RedpandaProducer,
  TOPICS,
  V1_FEEDS,
  type FeedId,
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
  // Always publish first value
  if (ctx.previousValue === null || ctx.lastPublishedAt === null) return true

  // Heartbeat: publish if enough time elapsed
  if (ctx.now - ctx.lastPublishedAt >= ctx.heartbeatIntervalMs) return true

  // Deviation: |new - old| / max(old, 1) * 10000 > threshold
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
}

/** Attest, persist to ClickHouse, and fanout to Redpanda. */
export async function publishFeedValue(
  result: FeedComputeResult,
  attestation: AttestationService,
  clickhouse: OracleClickHouse,
  producer: RedpandaProducer,
  config: WorkerConfig,
): Promise<void> {
  const now = new Date()
  const def = V1_FEEDS[result.feedId]

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
    value_json: result.valueJson,
    value_usd: result.valueUsd,
    value_index: result.valueIndex,
    confidence: result.completeness, // Plan 2A: completeness serves as confidence proxy
    completeness: result.completeness,
    freshness_ms: 0, // computed at publish time
    staleness_risk: 'low',
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

  // Fanout to Redpanda (uses publishJson added in this task — see note below)
  await producer.publishJson(TOPICS.INDEX_UPDATES, result.feedId, row)
}
```

- [ ] **Step 3b: Add `publishJson` method to RedpandaProducer**

In `packages/core/src/clients/redpanda.ts`, add to the `RedpandaProducer` class:

```typescript
/** Publish a generic JSON message (for INDEX_UPDATES fanout). */
async publishJson(topic: string, key: string, value: unknown): Promise<void> {
  if (!this.producer) throw new Error('Producer not connected')
  await this.producer.send({
    topic,
    messages: [{ key, value: JSON.stringify(value) }],
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run apps/worker/src/__tests__/publisher.test.ts
```

Expected: shouldPublish tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/publisher.ts apps/worker/src/__tests__/publisher.test.ts packages/core/src/clients/redpanda.ts
git commit -m "feat: add publisher with threshold/heartbeat gating, attestation, ClickHouse persist, Redpanda fanout"
```

---

### Task 13: Main Cycle + Entry Point

**Files:**
- Create: `apps/worker/src/cycle.ts`
- Create: `apps/worker/src/index.ts`
- Create: `apps/worker/src/__tests__/cycle.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/__tests__/cycle.test.ts
import { describe, it, expect, vi } from 'vitest'

describe('runCycle', () => {
  it('executes poll → ingest → compute → publish pipeline', async () => {
    // This is an integration-level test with mocked dependencies.
    // Verify the cycle calls each stage in order.
    // Full implementation TBD by implementer — structure the mock chain:
    // 1. pollAllTables returns events
    // 2. clickhouse.insertEvents called
    // 3. checkpoint.advance called
    // 4. clickhouse.queryWindowAggregates called
    // 5. computeAEGDP/AAI/APRI called
    // 6. shouldPublish checked per feed
    // 7. publishFeedValue called for changed feeds
    expect(true).toBe(true) // Placeholder — implementer fills in
  })
})
```

- [ ] **Step 2: Implement cycle.ts**

```typescript
// apps/worker/src/cycle.ts
import type pg from 'pg'
import {
  OracleClickHouse,
  RedpandaProducer,
  AttestationService,
  V1_FEEDS,
  computeAEGDP,
  computeAAI,
  computeAPRI,
  type FeedId,
} from '@lucid/oracle-core'
import type { WorkerConfig } from './config.js'
import { CheckpointManager } from './checkpoint.js'
import { pollAllTables } from './poller.js'
import { buildAEGDPInputs, buildAAIInputs, buildAPRIInputs } from './compute.js'
import { shouldPublish, publishFeedValue, type FeedComputeResult } from './publisher.js'

// Track last publish time per feed (in-memory, seeded from ClickHouse on first cycle)
const lastPublishTime = new Map<string, number>()

/** Seed lastPublishTime from ClickHouse — call once before first cycle. */
export async function seedLastPublishTimes(clickhouse: OracleClickHouse): Promise<void> {
  for (const def of Object.values(V1_FEEDS)) {
    const prev = await clickhouse.queryLatestPublishedValue(def.id, def.version)
    if (prev) {
      lastPublishTime.set(def.id, new Date(prev.computed_at).getTime())
    }
  }
}

export async function runCycle(
  config: WorkerConfig,
  clickhouse: OracleClickHouse,
  producer: RedpandaProducer,
  attestation: AttestationService,
  checkpointMgr: CheckpointManager,
  pool: pg.Pool,
): Promise<void> {
  const now = Date.now()
  const windowMs = config.computationWindowMs
  const windowSeconds = windowMs / 1000
  const from = new Date(now - windowMs)
  const to = new Date(now)

  // 1. Poll gateway tables
  const checkpoints = await checkpointMgr.loadAll()
  const { events, updates } = await pollAllTables(pool, checkpoints)

  // 2. Ingest into ClickHouse
  if (events.length > 0) {
    await clickhouse.insertEvents(events)
  }

  // 3. Advance checkpoints
  for (const u of updates) {
    await checkpointMgr.advance(u.table, u.ts, u.id)
  }

  // 4. Compute feeds
  const [windowAgg, protocolUsd, activeBuckets, providerCounts] = await Promise.all([
    clickhouse.queryWindowAggregates(from, to),
    clickhouse.queryProtocolUsdBreakdown(from, to),
    clickhouse.queryActiveBucketCount(from, to),
    clickhouse.queryProviderEventCounts(from, to),
  ])

  const totalBuckets = Math.floor(windowMs / 60000)
  const hasData = windowAgg.total_events > 0
  const completeness = hasData ? 1.0 : 0.0

  // AEGDP
  const aegdpInputs = buildAEGDPInputs(protocolUsd)
  const aegdpResult = computeAEGDP(aegdpInputs)

  // AAI
  const aaiInputs = buildAAIInputs(windowAgg, windowSeconds)
  const aaiResult = computeAAI(aaiInputs)

  // APRI
  const apriInputs = buildAPRIInputs(windowAgg, providerCounts, activeBuckets, totalBuckets)
  const apriResult = computeAPRI(apriInputs)

  // 5. Threshold check + publish
  const feedResults: FeedComputeResult[] = [
    {
      feedId: 'aegdp',
      valueJson: JSON.stringify({ value_usd: aegdpResult.value_usd, breakdown: aegdpResult.breakdown }),
      valueUsd: aegdpResult.value_usd,
      valueIndex: null,
      inputManifestHash: aegdpResult.input_manifest_hash,
      computationHash: aegdpResult.computation_hash,
      completeness,
    },
    {
      feedId: 'aai',
      valueJson: JSON.stringify({ value: aaiResult.value, breakdown: aaiResult.breakdown }),
      valueUsd: null,
      valueIndex: aaiResult.value,
      inputManifestHash: aaiResult.input_manifest_hash,
      computationHash: aaiResult.computation_hash,
      completeness,
    },
    {
      feedId: 'apri',
      valueJson: JSON.stringify({ value: apriResult.value, breakdown: apriResult.breakdown }),
      valueUsd: null,
      valueIndex: apriResult.value,
      inputManifestHash: apriResult.input_manifest_hash,
      computationHash: apriResult.computation_hash,
      completeness,
    },
  ]

  for (const result of feedResults) {
    const def = V1_FEEDS[result.feedId]
    const prev = await clickhouse.queryLatestPublishedValue(result.feedId, def.version)
    const prevValue = prev ? (prev.value_usd ?? prev.value_index ?? 0) : null
    const newValue = result.valueUsd ?? result.valueIndex ?? 0

    if (shouldPublish({
      feedId: result.feedId,
      newValue,
      previousValue: prevValue,
      thresholdBps: def.deviation_threshold_bps,
      lastPublishedAt: lastPublishTime.get(result.feedId) ?? null,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      now,
    })) {
      await publishFeedValue(result, attestation, clickhouse, producer, config)
      lastPublishTime.set(result.feedId, now)
    }
  }
}
```

- [ ] **Step 3: Implement index.ts (entry point)**

```typescript
// apps/worker/src/index.ts
import pg from 'pg'
import {
  OracleClickHouse,
  RedpandaProducer,
  AttestationService,
} from '@lucid/oracle-core'
import { loadConfig } from './config.js'
import { acquireAdvisoryLock } from './lock.js'
import { CheckpointManager } from './checkpoint.js'
import { runCycle, seedLastPublishTimes } from './cycle.js'

const { Pool } = pg
const config = loadConfig()

console.log('Oracle Worker starting...')
console.log(`  Poll interval: ${config.pollIntervalMs}ms`)
console.log(`  Computation window: ${config.computationWindowMs}ms`)
console.log(`  Heartbeat interval: ${config.heartbeatIntervalMs}ms`)

// Acquire advisory lock
const lock = await acquireAdvisoryLock(config.databaseUrl, config.workerLockId)
if (!lock) {
  console.log('Another worker instance is running — exiting cleanly')
  process.exit(0)
}

console.log('Advisory lock acquired')

// Initialize clients
const clickhouse = new OracleClickHouse({
  url: config.clickhouseUrl,
  username: config.clickhouseUser,
  password: config.clickhousePassword,
})

const producer = new RedpandaProducer({
  brokers: config.redpandaBrokers,
  clientId: 'oracle-worker',
})
await producer.connect()

const attestation = new AttestationService({ privateKeyHex: config.attestationKey })
const checkpointMgr = new CheckpointManager(config.databaseUrl)
const pool = new Pool({ connectionString: config.databaseUrl })

// Seed last publish times from ClickHouse (avoids spurious first-cycle publishes)
await seedLastPublishTimes(clickhouse)
console.log('Last publish times seeded from ClickHouse')

// Graceful shutdown
let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  console.log('Shutting down...')
  await lock.release()
  await producer.disconnect()
  await clickhouse.close()
  await checkpointMgr.close()
  await pool.end()
  console.log('Shutdown complete')
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Non-overlapping poll loop
const runLoop = async () => {
  while (!shuttingDown) {
    try {
      console.log(`[${new Date().toISOString()}] Starting poll cycle`)
      await runCycle(config, clickhouse, producer, attestation, checkpointMgr, pool)
      console.log(`[${new Date().toISOString()}] Cycle complete`)
    } catch (err) {
      console.error('Cycle error:', err)
    }

    // Non-overlapping: setTimeout after completion, not setInterval
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs))
  }
}

runLoop()
```

- [ ] **Step 4: Run all tests + typecheck**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass, zero type errors

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/cycle.ts apps/worker/src/index.ts apps/worker/src/__tests__/cycle.test.ts
git commit -m "feat: add worker main cycle + entry point with non-overlapping poll loop"
```

---

## Chunk 4: API Upgrade & Finalization

### Task 14: API ClickHouse Backfill + Redpanda Consumer

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/routes/v1.ts`
- Modify: `packages/core/src/clients/redpanda.ts`

- [ ] **Step 0: Add `runRaw` method to RedpandaConsumer**

In `packages/core/src/clients/redpanda.ts`, add to the `RedpandaConsumer` class:

```typescript
/** Run consumer with raw string messages (for INDEX_UPDATES — not RawEconomicEvent). */
async runRaw(handler: (key: string | null, value: string | null) => Promise<void>): Promise<void> {
  if (!this.consumer) throw new Error('Consumer not connected')
  await this.consumer.run({
    eachMessage: async ({ message }) => {
      await handler(
        message.key?.toString() ?? null,
        message.value?.toString() ?? null,
      )
    },
  })
}
```

- [ ] **Step 1: Update v1.ts — internalize updateFeedValue**

In `apps/api/src/routes/v1.ts`:
- Remove `export` from `updateFeedValue` (keep function, make internal)
- Add `initFeedCache(clickhouse)` function for backfill
- Add `handleIndexUpdate(message)` function for consumer

```typescript
// At top of v1.ts, add imports:
import {
  V1_FEEDS, CONFIDENCE_WEIGHTS,
  OracleClickHouse, RedpandaConsumer, TOPICS,
  type FeedId, type PublishedFeedValue, type PublishedFeedRow,
} from '@lucid/oracle-core'

// Replace Map type with richer data:
const latestFeedValues = new Map<string, PublishedFeedRow>()

/** Map internal PublishedFeedRow to the public API response shape.
 *  MUST preserve backward compatibility with Plan 1's PublishedFeedValue format. */
function toPublicFeedValue(row: PublishedFeedRow): {
  feed_id: string; value: string; confidence: number; completeness: number;
  freshness_ms: number; staleness_risk: string; computed_at: string;
  signer: string; signature: string;
} {
  const sigs = JSON.parse(row.signatures_json) as Array<{ signer: string; sig: string }>
  return {
    feed_id: row.feed_id,
    value: row.value_json,
    confidence: row.confidence,
    completeness: row.completeness,
    freshness_ms: row.freshness_ms,
    staleness_risk: row.staleness_risk,
    computed_at: row.computed_at,
    signer: sigs[0]?.signer ?? row.signer_set_id,
    signature: sigs[0]?.sig ?? '',
  }
}

// Internal only — no longer exported
function updateFeedValue(feedId: string, row: PublishedFeedRow): void {
  const existing = latestFeedValues.get(feedId)
  // Only update if newer
  if (!existing || row.computed_at > existing.computed_at) {
    latestFeedValues.set(feedId, row)
  }
}

/** Backfill cache from ClickHouse on startup. */
export async function initFeedCache(clickhouse: OracleClickHouse): Promise<void> {
  for (const def of Object.values(V1_FEEDS)) {
    const row = await clickhouse.queryLatestPublishedValue(def.id, def.version)
    if (row) {
      latestFeedValues.set(def.id, row)
    }
  }
}

/** Handle INDEX_UPDATES message from Redpanda consumer. */
export function handleIndexUpdate(messageValue: string): void {
  try {
    const row = JSON.parse(messageValue) as PublishedFeedRow
    if (!row.feed_id || !row.computed_at) {
      console.warn('Ignoring INDEX_UPDATES message: missing feed_id or computed_at')
      return
    }
    updateFeedValue(row.feed_id, row)
  } catch {
    console.error('Failed to parse INDEX_UPDATES message')
  }
}

/** Reconcile cache against ClickHouse (closes startup race window). */
export async function reconcileFeedCache(clickhouse: OracleClickHouse): Promise<void> {
  for (const def of Object.values(V1_FEEDS)) {
    const row = await clickhouse.queryLatestPublishedValue(def.id, def.version)
    if (row) {
      updateFeedValue(def.id, row)
    }
  }
}
```

Update endpoint handlers to use `toPublicFeedValue()` for backward-compatible responses:

```typescript
// In GET /v1/oracle/feeds — change latest_value line:
latest_value: (() => { const r = latestFeedValues.get(f.id); return r ? toPublicFeedValue(r) : null })(),

// In GET /v1/oracle/feeds/:id — change latest line:
const row = latestFeedValues.get(id)
return { feed: def, latest: row ? toPublicFeedValue(row) : null, methodology_url: def.methodology_url }

// In GET /v1/oracle/reports/latest — change feedValues mapping:
const feedValues = Array.from(latestFeedValues.entries()).map(([, r]) => toPublicFeedValue(r))
```

The API response shape stays identical to Plan 1 — `toPublicFeedValue()` ensures the external contract is preserved.

- [ ] **Step 2: Update server.ts startup sequence**

```typescript
// apps/api/src/server.ts
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { OracleClickHouse, RedpandaConsumer, TOPICS } from '@lucid/oracle-core'
import { registerOracleRoutes, initFeedCache, handleIndexUpdate, reconcileFeedCache } from './routes/v1.js'

const PORT = parseInt(process.env.PORT ?? '4040', 10)
const app = Fastify({ logger: true })

await app.register(cors, {
  origin: true,
  exposedHeaders: ['X-Request-Id'],
})

app.get('/health', async () => ({
  status: 'ok',
  service: 'oracle-economy-api',
  timestamp: new Date().toISOString(),
}))

registerOracleRoutes(app)

// Plan 2A startup sequence
const clickhouseUrl = process.env.CLICKHOUSE_URL
const redpandaBrokers = process.env.REDPANDA_BROKERS

let clickhouse: OracleClickHouse | null = null
let consumer: RedpandaConsumer | null = null

if (clickhouseUrl && redpandaBrokers) {
  // 1. Connect to ClickHouse
  clickhouse = new OracleClickHouse({
    url: clickhouseUrl,
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
  })

  // 2. Connect Redpanda consumer
  const hostname = process.env.HOSTNAME ?? `api-${process.pid}`
  consumer = new RedpandaConsumer({
    brokers: redpandaBrokers.split(','),
    groupId: `oracle-api-${hostname}`,
  })

  // 3. Backfill from ClickHouse
  await initFeedCache(clickhouse)
  app.log.info('Feed cache backfilled from ClickHouse')

  // 4. Start consumer (uses runRaw — see implementation note #1 below)
  await consumer.subscribe([TOPICS.INDEX_UPDATES])
  consumer.runRaw(async (_key, value) => {
    if (value) handleIndexUpdate(value)
  })
  app.log.info('INDEX_UPDATES consumer started')

  // 5. Reconcile
  await reconcileFeedCache(clickhouse)
  app.log.info('Feed cache reconciled')
} else {
  app.log.warn('CLICKHOUSE_URL or REDPANDA_BROKERS not set — running in Plan 1 mode (empty cache)')
}

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...')
  await consumer?.disconnect()
  await clickhouse?.close()
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

try {
  await app.listen({ port: PORT, host: '0.0.0.0' })
  console.log(`Oracle Economy API listening on :${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

export { app }
```

- [ ] **Step 3: Update API tests**

**Breaking test update:** The existing test at line 62-86 of `api.test.ts` imports `updateFeedValue` which is no longer exported. Replace it and add new tests:

```typescript
// In apps/api/src/__tests__/api.test.ts:
// 1. Change import line to include handleIndexUpdate:
import { registerOracleRoutes, _resetFeedValues, handleIndexUpdate } from '../routes/v1.js'

// 2. Replace the test at line 62-86 with:
it('GET /v1/oracle/reports/latest returns data after handleIndexUpdate', async () => {
  const msg = JSON.stringify({
    feed_id: 'aegdp',
    feed_version: 1,
    computed_at: '2026-03-12T00:00:00.000Z',
    revision: 0,
    value_json: '{"value_usd":12345.67}',
    value_usd: 12345.67,
    value_index: null,
    confidence: 0.85,
    completeness: 0.9,
    freshness_ms: 5000,
    staleness_risk: 'low',
    revision_status: 'preliminary',
    methodology_version: 1,
    input_manifest_hash: 'abc',
    computation_hash: 'def',
    signer_set_id: 'test-signer',
    signatures_json: '[{"signer":"test-signer","signature":"sig123"}]',
    source_coverage: '["lucid_gateway"]',
    published_solana: null,
    published_base: null,
  })
  handleIndexUpdate(msg)

  const res = await app.inject({ method: 'GET', url: '/v1/oracle/reports/latest' })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  expect(body.report).not.toBeNull()
  expect(body.report.feeds).toHaveLength(1)
  expect(body.report.feeds[0].feed_id).toBe('aegdp')

  // Verify backward-compatible response shape
  const feedRes = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp' })
  const feedBody = feedRes.json()
  expect(feedBody.latest).not.toBeNull()
  expect(feedBody.latest.value).toBe('{"value_usd":12345.67}')
  expect(feedBody.latest.signer).toBe('test-signer')
})

// 3. Add handleIndexUpdate validation test:
it('handleIndexUpdate ignores malformed messages', () => {
  handleIndexUpdate('not json')
  handleIndexUpdate('{}') // missing feed_id — should not crash
})
```

- [ ] **Step 4: Run all tests**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/redpanda.ts apps/api/src/server.ts apps/api/src/routes/v1.ts apps/api/src/__tests__/api.test.ts
git commit -m "feat: upgrade API with ClickHouse backfill, Redpanda consumer, internalized updateFeedValue"
```

---

### Task 15: API Methodology Endpoint Extension

**Files:**
- Modify: `apps/api/src/routes/v1.ts`

- [ ] **Step 1: Extend methodology endpoint**

Replace the methodology route handler to return feed-specific computation details:

```typescript
app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id/methodology', async (request, reply) => {
  const { id } = request.params
  const def = V1_FEEDS[id as FeedId]
  if (!def) {
    return reply.status(404).send({ error: 'Feed not found', feed_id: id })
  }

  const base = {
    feed_id: id,
    version: def.version,
    name: def.name,
    description: def.description,
    update_interval_ms: def.update_interval_ms,
    deviation_threshold_bps: def.deviation_threshold_bps,
    confidence_formula: {
      version: CONFIDENCE_WEIGHTS.version,
      weights: { ...CONFIDENCE_WEIGHTS },
    },
  }

  // Feed-specific computation details
  if (id === 'aai') {
    return {
      ...base,
      computation: {
        type: 'activity_index',
        range: [0, 1000],
        normalization: 'log10',
        weights: { active_agents: 0.25, throughput_per_second: 0.25, authentic_tool_call_volume: 0.25, model_provider_diversity: 0.25 },
        anchors: { active_agents: 100, throughput_per_second: 10, authentic_tool_call_volume: 10000, model_provider_diversity: 50 },
        formula: 'min(1000, log10(value+1) / log10(anchor+1) * 1000)',
      },
      canonical_json_version: 'v1',
    }
  }

  if (id === 'apri') {
    return {
      ...base,
      computation: {
        type: 'risk_index',
        range_bps: [0, 10000],
        scaling: 'raw_fraction * 10000',
        weights: { error_rate: 0.30, provider_concentration: 0.25, authenticity_ratio: 0.25, activity_continuity: 0.20 },
        dimensions: {
          error_rate: { scope: 'llm_inference + tool_call' },
          provider_concentration: { method: 'HHI', scope: 'provider IS NOT NULL' },
          authenticity_ratio: { scope: 'all events' },
          activity_continuity: { scope: 'all events', bucket_size_ms: 60000 },
        },
      },
      canonical_json_version: 'v1',
    }
  }

  // AEGDP (default)
  return {
    ...base,
    computation: {
      type: 'economic_gdp',
      unit: 'USD',
      components: ['protocol_payments_usd', 'protocol_task_revenue_usd', 'protocol_revenue_distributed_usd'],
      formula: 'sum(all_protocol_values_across_components)',
    },
    canonical_json_version: 'v1',
  }
})
```

- [ ] **Step 2: Update methodology test**

```typescript
it('GET /v1/oracle/feeds/aai/methodology returns computation details', async () => {
  const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aai/methodology' })
  expect(res.statusCode).toBe(200)
  const body = JSON.parse(res.payload)
  expect(body.computation.type).toBe('activity_index')
  expect(body.computation.weights.active_agents).toBe(0.25)
  expect(body.canonical_json_version).toBe('v1')
})
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run && npx tsc --noEmit
```

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/v1.ts apps/api/src/__tests__/api.test.ts
git commit -m "feat: extend methodology endpoint with feed-specific computation details"
```

---

### Task 16: Dockerfile Update

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Add worker target to Dockerfile**

Add a multi-target Dockerfile that supports both api and worker:

```dockerfile
FROM node:20-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN npm install
COPY . .

# API target (default)
FROM base AS api
EXPOSE 4040
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4040)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/api/src/server.ts"]

# Worker target
FROM base AS worker
CMD ["npx", "tsx", "apps/worker/src/index.ts"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "feat: add multi-target Dockerfile — api (default) + worker"
```

---

## Final Verification

After all 16 tasks are complete:

- [ ] **Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass (32 existing + ~25 new = ~57 total)

- [ ] **Typecheck**

```bash
npx tsc --noEmit
```

Expected: Zero errors

- [ ] **Verify git log**

```bash
git log --oneline -20
```

Expected: 16 new commits, one per task, all on main

---

## Implementation Notes for Agentic Workers

1. **RedpandaConsumer needs a `runRaw` method.** The existing `run()` method parses all messages as `RawEconomicEvent`. For `INDEX_UPDATES`, the API needs raw JSON strings. Add to `RedpandaConsumer`:
   ```typescript
   async runRaw(handler: (key: string | null, value: string | null) => Promise<void>): Promise<void> {
     if (!this.consumer) throw new Error('Consumer not connected')
     await this.consumer.run({
       eachMessage: async ({ message }) => {
         await handler(message.key?.toString() ?? null, message.value?.toString() ?? null)
       },
     })
   }
   ```

2. **RedpandaProducer needs `publishJson`.** The existing `publishEvents` only accepts `RawEconomicEvent[]`. Add to `RedpandaProducer`:
   ```typescript
   async publishJson(topic: string, key: string, value: unknown): Promise<void> {
     if (!this.producer) throw new Error('Producer not connected')
     await this.producer.send({
       topic,
       messages: [{ key, value: JSON.stringify(value) }],
     })
   }
   ```

3. **`PublishedFeedValue` vs `PublishedFeedRow`.** The API's route handlers currently use `PublishedFeedValue` (Plan 1 type). After Task 14, the internal cache uses `PublishedFeedRow` (richer ClickHouse schema). Map `PublishedFeedRow` to the public API response shape in each handler. Do NOT change the external API contract.

4. **Payment session `corrects_event_id` for re-emits.** The poller (Task 10) must set `corrects_event_id` when re-emitting a payment session due to `updated_at` change. `computeEventId('lucid_gateway', 'offchain', null, null, 'payment_' + session.id)` is deterministic — the "previous" event_id is the same as the "new" event_id since both use the same session ID. To differentiate, the poller should include a version suffix: `payment_${session.id}_v${version}` where version increments. The spec says "deterministic from the current row state" — use a hash of the row state as the differentiator.

5. **Completeness is binary in Plan 2A.** `completeness` is `1.0` if `total_events > 0`, else `0.0`. This is a deliberate simplification — Plan 2A only has one source (lucid_gateway). Multi-source weighted completeness is deferred to Plan 3.

6. **ClickHouse DateTime binding format.** Use `YYYY-MM-DD HH:MM:SS` (not ISO-8601 with ms/Z) for `{param:DateTime}` bindings. The `toClickHouseDateTime()` helper in `clickhouse.ts` handles this conversion.
