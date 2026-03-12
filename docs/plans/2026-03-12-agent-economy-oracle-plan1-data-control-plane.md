# Agent Economy Oracle — Plan 1: Data Plane + Control Plane Foundation

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational data and control plane: typed event model, ClickHouse/Redpanda clients, gateway adapter, AEGDP feed computation (pure function), attestation service, control plane schema, and a REST API that serves feed definitions and accepts computed values. This plan ships the building blocks; the automated feed worker pipeline that connects them end-to-end is Plan 2.

**Architecture:** A standalone repo (`lucid-agent-oracle`) with `packages/core/` (library: types, clients, adapters, services, feeds) and `apps/api/` (Fastify server on :4040). Reads from the Lucid gateway's Postgres tables via `DATABASE_URL` (same Supabase instance). No code-level dependency on platform-core. By the end of this plan, all primitives exist to compute and attest feed values, but the orchestration (gateway poll → transform → compute → attest → publish) is wired in Plan 2.

**Tech Stack:** ClickHouse Cloud (via `@clickhouse/client`), Redpanda (via `kafkajs`), Fastify, Vitest, Ed25519 (`@noble/ed25519`), pg (direct Postgres for gateway table reads).

**Repo:** `lucid-agent-oracle` (standalone, MIT licensed)

**Spec:** In platform-core: `docs/superpowers/specs/2026-03-12-agent-economy-oracle-design.md`

**Scope Note:** This is Plan 1 of 4. This plan covers Data Plane + Control Plane only. Plans 2-4 cover Publication, Product, and External Adapters respectively.

---

## File Structure

```
lucid-agent-oracle/                       # Standalone repo (MIT)
├── package.json                          # Root workspace config
├── tsconfig.json                         # Base TypeScript config
├── vitest.config.ts                      # Test runner config
├── .gitignore
├── LICENSE                               # MIT
├── packages/
│   └── core/                             # @lucid/oracle-core (publishable library)
│       ├── package.json
│       └── src/
│           ├── index.ts                  # Barrel exports
│           ├── types/
│           │   ├── index.ts              # Type re-exports
│           │   ├── events.ts             # RawEconomicEvent, computeEventId
│           │   ├── feeds.ts              # FeedDefinition, FeedValue, PublishedFeedValue
│           │   ├── entities.ts           # AgentEntity, WalletMapping, IdentityLink
│           │   └── quality.ts            # QualityEnvelope, ConfidenceInputs
│           ├── clients/
│           │   ├── clickhouse.ts         # ClickHouse client wrapper
│           │   └── redpanda.ts           # Kafka producer/consumer wrapper
│           ├── adapters/
│           │   └── gateway-tap.ts        # Lucid Gateway DB → raw_economic_events
│           ├── services/
│           │   ├── attestation-service.ts        # Ed25519 signing
│           │   ├── feed-computation-service.ts   # (Plan 2)
│           │   ├── confidence-service.ts         # Deterministic confidence scoring
│           │   └── privacy-service.ts            # (Plan 3)
│           ├── feeds/
│           │   ├── aegdp.ts              # AEGDP feed computation
│           │   ├── aai.ts                # AAI feed computation (Plan 2)
│           │   └── apri.ts              # APRI feed computation (Plan 2)
│           └── __tests__/
│               ├── events.test.ts
│               ├── clickhouse.test.ts
│               ├── gateway-tap.test.ts
│               ├── feed-computation.test.ts
│               ├── confidence.test.ts
│               ├── attestation.test.ts
│               ├── redpanda.test.ts
│               └── privacy.test.ts       # (Plan 3)
├── apps/
│   └── api/                              # @lucid/oracle-api (Fastify :4040)
│       ├── package.json
│       └── src/
│           ├── server.ts                 # Entry point
│           ├── routes/
│           │   └── v1.ts                 # /v1/oracle/* endpoints
│           └── __tests__/
│               └── api.test.ts           # API integration tests
├── migrations/
│   └── 001_control_plane.sql             # Oracle control plane tables (Postgres)
└── Dockerfile                            # Railway deployment
```

---

## Chunk 1: Module Scaffolding + Types

### Task 1: Create module scaffold

**Files:**
- Create: `package.json` (root workspace)
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `packages/core/package.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/src/types/index.ts`
- Create: `packages/core/src/types/events.ts`
- Create: `packages/core/src/types/feeds.ts`
- Create: `packages/core/src/types/entities.ts`
- Create: `packages/core/src/types/quality.ts`

- [ ] **Step 0: Initialize the repo**

```bash
mkdir lucid-agent-oracle && cd lucid-agent-oracle
git init
```

Create root `package.json`:
```json
{
  "name": "lucid-agent-oracle",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "dev": "tsx apps/api/src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "migrate": "node scripts/migrate.js"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["packages/*/src/**/*", "apps/*/src/**/*"]
}
```

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/__tests__/**/*.test.ts',
      'apps/*/src/__tests__/**/*.test.ts',
    ],
  },
})
```

Create `.gitignore`:
```
node_modules/
dist/
.env
.env.*
*.log
```

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@lucid/oracle-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@clickhouse/client": "^1.8.0",
    "kafkajs": "^2.2.4",
    "@noble/ed25519": "^2.2.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0"
  }
}
```

- [ ] **Step 2: Create event types**

File: `packages/core/src/types/events.ts`

```typescript
/** Canonical raw economic event — the single source of truth.
 *  Maps 1:1 to the ClickHouse raw_economic_events table. */
export interface RawEconomicEvent {
  event_id: string                       // deterministic UUID
  // Provenance
  source: EventSource
  source_adapter_ver: number
  ingestion_type: 'realtime' | 'backfill' | 'correction'
  ingestion_ts: Date
  // Chain anchor
  chain: ChainId
  block_number: number | null
  tx_hash: string | null
  log_index: number | null
  // Event classification
  event_type: EventType
  event_timestamp: Date
  // Entity references
  subject_entity_id: string | null       // canonical agent_entity_id
  subject_raw_id: string
  subject_id_type: SubjectIdType
  counterparty_raw_id: string | null
  protocol: ProtocolId
  // Economic signal
  amount: string | null                  // string to avoid float precision
  currency: string | null
  usd_value: string | null
  // Context metadata
  tool_name: string | null
  model_id: string | null
  provider: string | null
  duration_ms: number | null
  status: EventStatus
  // Quality
  quality_score: number                  // 0.0-1.0
  economic_authentic: boolean
  // Correction chain
  corrects_event_id: string | null
  correction_reason: string | null
}

export type EventSource =
  | 'lucid_gateway'
  | 'virtuals_acp'
  | 'olas_gnosis'
  | 'olas_base'
  | 'olas_optimism'
  | 'erc8004_eth'
  | 'agent_wallets_sol'
  | 'agent_wallets_evm'
  | 'cookie_api'

export type ChainId =
  | 'solana'
  | 'base'
  | 'ethereum'
  | 'gnosis'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'offchain'

export type EventType =
  | 'payment'
  | 'llm_inference'
  | 'tool_call'
  | 'task_complete'
  | 'agent_register'
  | 'revenue_distribute'
  | 'swap'
  | 'stake'
  | 'identity_link'
  | 'reputation_update'

export type SubjectIdType =
  | 'wallet'
  | 'tenant'
  | 'erc8004'
  | 'protocol_native'

export type ProtocolId =
  | 'lucid'
  | 'virtuals'
  | 'olas'
  | 'independent'

export type EventStatus =
  | 'success'
  | 'error'
  | 'timeout'
  | 'denied'

import { createHash } from 'node:crypto'

/** Deterministic event ID from natural key */
export function computeEventId(
  source: string,
  chain: string,
  txHash: string | null,
  logIndex: number | null,
  fallbackKey?: string,
): string {
  const input = `${source}:${chain}:${txHash ?? 'none'}:${logIndex ?? 'none'}:${fallbackKey ?? ''}`
  const hash = createHash('sha256').update(input).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}
```

- [ ] **Step 3: Create quality types**

File: `packages/core/src/types/quality.ts`

```typescript
/** Quality envelope attached to every metric response */
export interface QualityEnvelope {
  confidence: number          // 0.0-1.0, deterministic formula
  completeness: number        // 0.0-1.0, % of expected data present
  freshness_ms: number        // age of newest input event
  staleness_risk: 'low' | 'medium' | 'high'
  revision: RevisionStatus
  source_coverage: Record<string, boolean>
}

export type RevisionStatus = 'preliminary' | 'revised' | 'final' | 'exceptional'

/** Inputs to the confidence formula */
export interface ConfidenceInputs {
  source_diversity_score: number     // [0,1] ratio of reporting sources
  identity_confidence: number        // [0,1] avg entity resolution confidence
  data_completeness: number          // [0,1] % of data points present
  anomaly_cleanliness: number        // [0,1] 1.0 if clean, decays
  freshness_score: number            // [0,1] exp(-age / expected_interval)
  revision_stability: number         // [0,1] 1.0 - revision_probability
}

/** Confidence formula weights — versioned */
export const CONFIDENCE_WEIGHTS = {
  version: 1,
  source_diversity_score: 0.25,
  identity_confidence: 0.20,
  data_completeness: 0.20,
  anomaly_cleanliness: 0.15,
  freshness_score: 0.10,
  revision_stability: 0.10,
} as const
```

- [ ] **Step 4: Create feed types**

File: `packages/core/src/types/feeds.ts`

```typescript
import type { QualityEnvelope } from './quality.js'

export type FeedId = 'aegdp' | 'aai' | 'apri'

/** A computed, versioned, published index */
export interface FeedDefinition {
  id: FeedId
  name: string
  description: string
  version: number
  methodology_url: string
  update_interval_ms: number         // expected update cadence
  deviation_threshold_bps: number    // basis points deviation trigger
}

/** A feed value with full provenance */
export interface PublishedFeedValue {
  feed_id: FeedId
  feed_version: number
  computed_at: Date
  revision: number                   // 0 = original, 1+ = restatement
  // Value
  value_json: string                 // JSON-encoded feed-specific payload
  value_usd: string | null           // primary USD value (for AEGDP)
  value_index: number | null         // primary index value (for AAI)
  // Quality
  quality: QualityEnvelope
  // Provenance
  input_manifest_hash: string        // SHA256 of input event set
  computation_hash: string           // SHA256 of feed spec version
  methodology_version: number
  // Attestation
  signer_set_id: string
  signatures: Array<{ signer: string; sig: string }>
  // Publication status
  published_solana: boolean
  published_base: boolean
}

/** The V1 feed definitions */
export const V1_FEEDS: Record<FeedId, FeedDefinition> = {
  aegdp: {
    id: 'aegdp',
    name: 'Agent Economy GDP',
    description: 'Total economic output across all indexed protocols',
    version: 1,
    methodology_url: '/v1/oracle/feeds/aegdp/methodology',
    update_interval_ms: 5 * 60 * 1000,  // 5 minutes
    deviation_threshold_bps: 100,         // 1%
  },
  aai: {
    id: 'aai',
    name: 'Agent Activity Index',
    description: 'Composite of active agents, tasks/sec, tool calls, unique interactions',
    version: 1,
    methodology_url: '/v1/oracle/feeds/aai/methodology',
    update_interval_ms: 5 * 60 * 1000,
    deviation_threshold_bps: 200,
  },
  apri: {
    id: 'apri',
    name: 'Agent Protocol Risk Index',
    description: 'Bundled health scores, reliability tiers, error rates, concentration',
    version: 1,
    methodology_url: '/v1/oracle/feeds/apri/methodology',
    update_interval_ms: 5 * 60 * 1000,
    deviation_threshold_bps: 500,
  },
}
```

- [ ] **Step 5: Create entity types**

File: `packages/core/src/types/entities.ts`

```typescript
/** Canonical agent identity — resolved across protocols */
export interface AgentEntity {
  id: string                          // ae_{random}
  created_at: Date
  updated_at: Date
  // Aggregated metadata (denormalized for quick access)
  wallet_count: number
  protocol_count: number
  total_economic_output_usd: string   // string for precision
  reputation_score: number            // 0-1000
  first_seen_at: Date
}

/** Maps a wallet address to a canonical agent entity */
export interface WalletMapping {
  wallet_address: string
  chain: string
  entity_id: string
  confidence: number                  // 0.0-1.0
  link_type: 'explicit_claim' | 'onchain_proof' | 'gateway_correlation' | 'behavioral_heuristic'
  evidence_hash: string | null        // hash of evidence (signed message, etc.)
  created_at: Date
}

/** Cross-protocol identity link */
export interface IdentityLink {
  id: string
  entity_id: string
  external_id: string                 // the ID in the external system
  external_system: string             // 'erc8004' | 'virtuals' | 'olas' | 'gateway_tenant'
  confidence: number
  link_type: 'explicit_claim' | 'onchain_proof' | 'gateway_correlation' | 'behavioral_heuristic'
  created_at: Date
}

/** Protocol registry entry */
export interface ProtocolEntry {
  id: string                          // 'lucid' | 'virtuals' | 'olas' | ...
  name: string
  chains: string[]
  contract_addresses: Record<string, string[]>  // chain → addresses
  adapter_id: string | null           // source connector reference
  created_at: Date
}
```

- [ ] **Step 6: Create barrel exports**

File: `packages/core/src/types/index.ts`

```typescript
export type {
  RawEconomicEvent,
  EventSource,
  ChainId,
  EventType,
  SubjectIdType,
  ProtocolId,
  EventStatus,
} from './events.js'
export { computeEventId } from './events.js'

export type {
  QualityEnvelope,
  RevisionStatus,
  ConfidenceInputs,
} from './quality.js'
export { CONFIDENCE_WEIGHTS } from './quality.js'

export type {
  FeedId,
  FeedDefinition,
  PublishedFeedValue,
} from './feeds.js'
export { V1_FEEDS } from './feeds.js'

export type {
  AgentEntity,
  WalletMapping,
  IdentityLink,
  ProtocolEntry,
} from './entities.js'
```

File: `packages/core/src/index.ts`

```typescript
// Types
export * from './types/index.js'
```

- [ ] **Step 7: Run npm install and typecheck**

Run: `npm install && npx tsc --noEmit`
Expected: No errors (types compile cleanly)

- [ ] **Step 8: Commit**

```bash
git add .
git commit -m "feat: scaffold repo with core package, event/feed/entity/quality types"
```

---

### Task 2: Event ID and normalization tests

**Files:**
- Create: `packages/core/src/__tests__/events.test.ts`

- [ ] **Step 1: Write failing tests for computeEventId**

```typescript
import { describe, it, expect } from 'vitest'
import { computeEventId } from '../types/events.js'

describe('computeEventId', () => {
  it('produces a deterministic UUID from natural key', () => {
    const id1 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_abc')
    const id2 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_abc')
    expect(id1).toBe(id2)
    // UUID format: 8-4-4-4-12
    expect(id1).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  })

  it('produces different IDs for different inputs', () => {
    const id1 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_abc')
    const id2 = computeEventId('lucid_gateway', 'offchain', null, null, 'receipt_def')
    expect(id1).not.toBe(id2)
  })

  it('uses tx_hash and log_index when available', () => {
    const id1 = computeEventId('virtuals_acp', 'base', '0xabc123', 0)
    const id2 = computeEventId('virtuals_acp', 'base', '0xabc123', 1)
    expect(id1).not.toBe(id2)
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run packages/core/src/__tests__/events.test.ts`
Expected: PASS (implementation already exists in types/events.ts)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/__tests__/events.test.ts
git commit -m "test(oracle-economy): add event ID determinism tests"
```

---

### Task 3: Confidence scoring service

**Files:**
- Create: `packages/core/src/services/confidence-service.ts`
- Create: `packages/core/src/__tests__/confidence.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { computeConfidence } from '../services/confidence-service.js'
import type { ConfidenceInputs } from '../types/quality.js'

describe('computeConfidence', () => {
  it('returns 1.0 for perfect inputs', () => {
    const inputs: ConfidenceInputs = {
      source_diversity_score: 1.0,
      identity_confidence: 1.0,
      data_completeness: 1.0,
      anomaly_cleanliness: 1.0,
      freshness_score: 1.0,
      revision_stability: 1.0,
    }
    expect(computeConfidence(inputs)).toBeCloseTo(1.0, 4)
  })

  it('returns 0.0 for zero inputs', () => {
    const inputs: ConfidenceInputs = {
      source_diversity_score: 0,
      identity_confidence: 0,
      data_completeness: 0,
      anomaly_cleanliness: 0,
      freshness_score: 0,
      revision_stability: 0,
    }
    expect(computeConfidence(inputs)).toBeCloseTo(0.0, 4)
  })

  it('weights source diversity highest (0.25)', () => {
    const base: ConfidenceInputs = {
      source_diversity_score: 0,
      identity_confidence: 0,
      data_completeness: 0,
      anomaly_cleanliness: 0,
      freshness_score: 0,
      revision_stability: 0,
    }
    const withDiversity = { ...base, source_diversity_score: 1.0 }
    const withFreshness = { ...base, freshness_score: 1.0 }
    expect(computeConfidence(withDiversity)).toBeGreaterThan(
      computeConfidence(withFreshness),
    )
    expect(computeConfidence(withDiversity)).toBeCloseTo(0.25, 4)
    expect(computeConfidence(withFreshness)).toBeCloseTo(0.10, 4)
  })

  it('clamps output to [0, 1]', () => {
    const inputs: ConfidenceInputs = {
      source_diversity_score: 1.5,  // invalid but should be clamped
      identity_confidence: 1.0,
      data_completeness: 1.0,
      anomaly_cleanliness: 1.0,
      freshness_score: 1.0,
      revision_stability: 1.0,
    }
    expect(computeConfidence(inputs)).toBeLessThanOrEqual(1.0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/confidence.test.ts`
Expected: FAIL — `computeConfidence` not found

- [ ] **Step 3: Implement confidence-service.ts**

```typescript
import { CONFIDENCE_WEIGHTS, type ConfidenceInputs } from '../types/quality.js'

/**
 * Compute deterministic confidence score from inputs.
 * All inputs must be in [0, 1] where higher = more confident.
 * Formula version is embedded in CONFIDENCE_WEIGHTS.version.
 */
export function computeConfidence(inputs: ConfidenceInputs): number {
  const w = CONFIDENCE_WEIGHTS
  const raw =
    clamp01(inputs.source_diversity_score) * w.source_diversity_score +
    clamp01(inputs.identity_confidence) * w.identity_confidence +
    clamp01(inputs.data_completeness) * w.data_completeness +
    clamp01(inputs.anomaly_cleanliness) * w.anomaly_cleanliness +
    clamp01(inputs.freshness_score) * w.freshness_score +
    clamp01(inputs.revision_stability) * w.revision_stability

  return clamp01(raw)
}

/** Compute freshness score with exponential decay */
export function computeFreshnessScore(
  ageMs: number,
  expectedIntervalMs: number,
): number {
  if (expectedIntervalMs <= 0) return 0
  return Math.exp(-ageMs / expectedIntervalMs)
}

/** Determine staleness risk level */
export function computeStalenessRisk(
  ageMs: number,
  expectedIntervalMs: number,
): 'low' | 'medium' | 'high' {
  const ratio = ageMs / expectedIntervalMs
  if (ratio < 2) return 'low'
  if (ratio < 5) return 'medium'
  return 'high'
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/__tests__/confidence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/confidence-service.ts packages/core/src/__tests__/confidence.test.ts
git commit -m "feat(oracle-economy): add deterministic confidence scoring service"
```

---

### Task 4: Attestation service (adapt from existing oracle)

**Files:**
- Create: `packages/core/src/services/attestation-service.ts`
- Create: `packages/core/src/__tests__/attestation.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { AttestationService, type ReportEnvelope } from '../services/attestation-service.js'

describe('AttestationService', () => {
  let service: AttestationService

  beforeEach(() => {
    // Use a test seed for deterministic key generation
    service = new AttestationService({ seed: 'test-seed-for-oracle-economy' })
  })

  it('creates a signed report envelope', () => {
    const envelope = service.signReport({
      feed_id: 'aegdp',
      feed_version: 1,
      report_timestamp: 1710288000,
      values: { aegdp: 847_000_000 },
      input_manifest_hash: 'abc123',
      computation_hash: 'def456',
      revision: 0,
    })
    expect(envelope.signer_set_id).toBe('ss_lucid_v1')
    expect(envelope.signatures).toHaveLength(1)
    expect(envelope.signatures[0].signer).toBeTruthy()
    expect(envelope.signatures[0].sig).toBeTruthy()
  })

  it('verifies a valid report', () => {
    const envelope = service.signReport({
      feed_id: 'aegdp',
      feed_version: 1,
      report_timestamp: 1710288000,
      values: { aegdp: 847_000_000 },
      input_manifest_hash: 'abc123',
      computation_hash: 'def456',
      revision: 0,
    })
    expect(service.verifyReport(envelope)).toBe(true)
  })

  it('rejects a tampered report', () => {
    const envelope = service.signReport({
      feed_id: 'aegdp',
      feed_version: 1,
      report_timestamp: 1710288000,
      values: { aegdp: 847_000_000 },
      input_manifest_hash: 'abc123',
      computation_hash: 'def456',
      revision: 0,
    })
    // Tamper with the value
    const tampered = { ...envelope, values: { aegdp: 999_000_000 } }
    expect(service.verifyReport(tampered)).toBe(false)
  })

  it('returns the public key', () => {
    const pubKey = service.getPublicKey()
    expect(pubKey).toMatch(/^[a-f0-9]{64}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/src/__tests__/attestation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement attestation-service.ts**

```typescript
import { createHash, createHmac } from 'node:crypto'
import * as ed from '@noble/ed25519'

export interface ReportPayload {
  feed_id: string
  feed_version: number
  report_timestamp: number
  values: Record<string, unknown>
  input_manifest_hash: string
  computation_hash: string
  revision: number
}

export interface ReportEnvelope extends ReportPayload {
  signer_set_id: string
  signatures: Array<{ signer: string; sig: string }>
}

interface AttestationConfig {
  privateKeyHex?: string    // 64-char hex (32 bytes)
  seed?: string             // derive key from seed via HKDF
}

export class AttestationService {
  private readonly privateKey: Uint8Array
  private readonly publicKeyHex: string

  constructor(config?: AttestationConfig) {
    if (config?.privateKeyHex) {
      this.privateKey = hexToBytes(config.privateKeyHex)
    } else if (config?.seed) {
      const derived = createHmac('sha512', 'lucid-oracle-economy')
        .update(config.seed)
        .digest()
      this.privateKey = new Uint8Array(derived.subarray(0, 32))
    } else {
      // Try env var
      const envKey = process.env.ORACLE_ATTESTATION_KEY
      if (envKey) {
        this.privateKey = hexToBytes(envKey)
      } else {
        // Generate ephemeral key (dev/test only)
        this.privateKey = ed.utils.randomPrivateKey()
      }
    }
    // @noble/ed25519 v2+ is synchronous by default.
    // The instanceof Promise checks are a safety net for unexpected versions.
    const pubBytes = ed.getPublicKey(this.privateKey)
    if (pubBytes instanceof Promise) {
      throw new Error('ed25519 sync mode required — ensure @noble/ed25519 v2+')
    }
    this.publicKeyHex = bytesToHex(pubBytes as Uint8Array)
  }

  signReport(payload: ReportPayload): ReportEnvelope {
    const message = this.canonicalize(payload)
    const msgBytes = new TextEncoder().encode(message)
    const sig = ed.sign(msgBytes, this.privateKey)
    if (sig instanceof Promise) {
      throw new Error('ed25519 sync mode required')
    }

    return {
      ...payload,
      signer_set_id: 'ss_lucid_v1',
      signatures: [{
        signer: this.publicKeyHex,
        sig: bytesToHex(sig as Uint8Array),
      }],
    }
  }

  verifyReport(envelope: ReportEnvelope): boolean {
    if (envelope.signatures.length === 0) return false
    const { signer_set_id, signatures, ...payload } = envelope
    const message = this.canonicalize(payload as ReportPayload)
    const msgBytes = new TextEncoder().encode(message)

    for (const { signer, sig } of signatures) {
      const valid = ed.verify(hexToBytes(sig), msgBytes, hexToBytes(signer))
      if (valid instanceof Promise) {
        throw new Error('ed25519 sync mode required')
      }
      if (!valid) return false
    }
    return true
  }

  getPublicKey(): string {
    return this.publicKeyHex
  }

  /** Deterministic JSON serialization with recursive key sorting.
   *  TODO(plan-2): Evaluate RFC 8785 (JCS) before on-chain publication. */
  private canonicalize(obj: unknown): string {
    if (obj === null || obj === undefined) return JSON.stringify(obj)
    if (typeof obj !== 'object') return JSON.stringify(obj)
    if (Array.isArray(obj)) return '[' + obj.map(v => this.canonicalize(v)).join(',') + ']'
    const sorted = Object.keys(obj as Record<string, unknown>).sort()
    const entries = sorted.map(k =>
      JSON.stringify(k) + ':' + this.canonicalize((obj as Record<string, unknown>)[k])
    )
    return '{' + entries.join(',') + '}'
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/__tests__/attestation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/attestation-service.ts packages/core/src/__tests__/attestation.test.ts
git commit -m "feat(oracle-economy): add Ed25519 attestation service with multi-signer-ready envelope"
```

---

## Chunk 2: ClickHouse Client + Postgres Migration

### Task 5: ClickHouse client wrapper

**Files:**
- Create: `packages/core/src/clients/clickhouse.ts`
- Create: `packages/core/src/__tests__/clickhouse.test.ts`

- [ ] **Step 1: Write failing tests (unit-level, no real ClickHouse)**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OracleClickHouse } from '../clients/clickhouse.js'

// Mock @clickhouse/client
vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn(() => ({
    query: vi.fn(),
    insert: vi.fn(),
    ping: vi.fn().mockResolvedValue({ success: true }),
    close: vi.fn(),
  })),
}))

describe('OracleClickHouse', () => {
  let client: OracleClickHouse

  beforeEach(() => {
    client = new OracleClickHouse({ url: 'http://localhost:8123' })
  })

  it('constructs with config', () => {
    expect(client).toBeDefined()
  })

  it('health check calls ping', async () => {
    const result = await client.healthCheck()
    expect(result).toBe(true)
  })

  it('insertEvents batches correctly', async () => {
    const events = [
      {
        event_id: 'test-id',
        source: 'lucid_gateway',
        source_adapter_ver: 1,
        ingestion_type: 'realtime',
        ingestion_ts: new Date(),
        chain: 'offchain',
        block_number: null,
        tx_hash: null,
        log_index: null,
        event_type: 'llm_inference',
        event_timestamp: new Date(),
        subject_entity_id: null,
        subject_raw_id: 'tenant_abc',
        subject_id_type: 'tenant',
        counterparty_raw_id: null,
        protocol: 'lucid',
        amount: null,
        currency: null,
        usd_value: '0.05',
        tool_name: null,
        model_id: 'gpt-4o',
        provider: 'openai',
        duration_ms: 1200,
        status: 'success',
        quality_score: 1.0,
        economic_authentic: true,
        corrects_event_id: null,
        correction_reason: null,
      },
    ]
    await client.insertEvents(events as any)
    const { createClient } = await import('@clickhouse/client')
    const mockInstance = (createClient as any).mock.results[0].value
    expect(mockInstance.insert).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'raw_economic_events' })
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/__tests__/clickhouse.test.ts`
Expected: FAIL — `OracleClickHouse` not found

- [ ] **Step 3: Implement ClickHouse client**

```typescript
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import type { RawEconomicEvent } from '../types/events.js'

export interface ClickHouseConfig {
  url: string
  username?: string
  password?: string
  database?: string
}

/** Typed result row from metric_rollups_1m aggregation */
export interface RollupRow {
  bucket: string
  total_authentic: string
  total_usd: string
  total_events: string
  total_success: string
  total_errors: string
}

/** Typed result row from published_feed_values */
export interface StoredFeedValue {
  feed_id: string
  computed_at: string
  value: string
  confidence: number
  completeness: number
  freshness_ms: number
  signer: string
  signature: string
}

export class OracleClickHouse {
  private readonly client: ClickHouseClient

  constructor(config: ClickHouseConfig) {
    this.client = createClient({
      url: config.url,
      username: config.username ?? 'default',
      password: config.password ?? '',
      database: config.database ?? 'default',
    })
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.ping()
      return result.success
    } catch {
      return false
    }
  }

  async insertEvents(events: RawEconomicEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.client.insert({
      table: 'raw_economic_events',
      values: events.map((e) => ({
        ...e,
        ingestion_ts: e.ingestion_ts.toISOString(),
        event_timestamp: e.event_timestamp.toISOString(),
        amount: e.amount ?? null,
        usd_value: e.usd_value ?? null,
      })),
      format: 'JSONEachRow',
    })
  }

  async queryFeedRollup(
    feedId: string,
    fromMinute: Date,
    toMinute: Date,
  ): Promise<RollupRow[]> {
    const result = await this.client.query({
      query: `
        SELECT
          bucket,
          sum(authentic_count) AS total_authentic,
          sum(total_usd_value) AS total_usd,
          sum(event_count) AS total_events,
          sum(success_count) AS total_success,
          sum(error_count) AS total_errors
        FROM metric_rollups_1m
        WHERE bucket >= {from:DateTime} AND bucket < {to:DateTime}
        GROUP BY bucket
        ORDER BY bucket
      `,
      query_params: {
        from: fromMinute.toISOString(),
        to: toMinute.toISOString(),
      },
      format: 'JSONEachRow',
    })
    return result.json()
  }

  async getLatestFeedValue(feedId: string): Promise<StoredFeedValue | null> {
    const result = await this.client.query({
      query: `
        SELECT *
        FROM published_feed_values
        WHERE feed_id = {feedId:String}
        ORDER BY computed_at DESC
        LIMIT 1
      `,
      query_params: { feedId },
      format: 'JSONEachRow',
    })
    const rows = await result.json<StoredFeedValue[]>()
    return rows[0] ?? null
  }

  async close(): Promise<void> {
    await this.client.close()
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/core/src/__tests__/clickhouse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/clickhouse.ts packages/core/src/__tests__/clickhouse.test.ts
git commit -m "feat(oracle-economy): add ClickHouse client wrapper with event insert and rollup query"
```

---

### Task 6: Postgres migration for control plane tables

**Files:**
- Create: `migrations/001_control_plane.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 001_control_plane.sql
-- Control plane tables for the Agent Economy Oracle.
-- These tables live in the same Supabase instance as platform-core (shared DATABASE_URL).
--
-- Tables deferred to later plans:
--   identity_evidence     → Plan 4 (external adapter identity resolution)
--   feed_versions         → Plan 2 (publication plane schema evolution)
--   feed_inputs           → Plan 2 (feed computation pipeline)
--   attestation_jobs      → Plan 2 (on-chain publication)
-- Tables reusing platform-core infrastructure (shared Supabase):
--   api_keys              → reads gateway_api_keys via DATABASE_URL (shared auth)
--   billing_accounts      → reads gateway_tenants plan tiers via DATABASE_URL
--   usage_metering        → own oracle_usage table (Plan 3)
--   mcp_tool_entitlements → Plan 3 (MCP tool registration)

-- Protocol registry: indexed protocols and their contract addresses
CREATE TABLE IF NOT EXISTS oracle_protocol_registry (
  id TEXT PRIMARY KEY,                     -- 'lucid' | 'virtuals' | 'olas' | ...
  name TEXT NOT NULL,
  chains TEXT[] NOT NULL DEFAULT '{}',
  contract_addresses JSONB NOT NULL DEFAULT '{}',
  adapter_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent entities: canonical resolved identities
CREATE TABLE IF NOT EXISTS oracle_agent_entities (
  id TEXT PRIMARY KEY,                     -- ae_{random}
  wallet_count INTEGER NOT NULL DEFAULT 0,
  protocol_count INTEGER NOT NULL DEFAULT 0,
  total_economic_output_usd NUMERIC NOT NULL DEFAULT 0,
  reputation_score INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallet mappings: wallet → entity resolution
CREATE TABLE IF NOT EXISTS oracle_wallet_mappings (
  wallet_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  confidence NUMERIC NOT NULL DEFAULT 0,
  link_type TEXT NOT NULL CHECK (link_type IN ('explicit_claim', 'onchain_proof', 'gateway_correlation', 'behavioral_heuristic')),
  evidence_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, chain)
);
CREATE INDEX IF NOT EXISTS idx_wallet_mappings_entity ON oracle_wallet_mappings(entity_id);

-- Identity links: cross-protocol identity associations
CREATE TABLE IF NOT EXISTS oracle_identity_links (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  external_id TEXT NOT NULL,
  external_system TEXT NOT NULL,           -- 'erc8004' | 'virtuals' | 'olas' | 'gateway_tenant'
  confidence NUMERIC NOT NULL DEFAULT 0,
  link_type TEXT NOT NULL CHECK (link_type IN ('explicit_claim', 'onchain_proof', 'gateway_correlation', 'behavioral_heuristic')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_id, external_system)
);
CREATE INDEX IF NOT EXISTS idx_identity_links_entity ON oracle_identity_links(entity_id);

-- Feed definitions: versioned computation specs
CREATE TABLE IF NOT EXISTS oracle_feed_definitions (
  id TEXT NOT NULL,                        -- 'aegdp' | 'aai' | 'apri'
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  methodology_json JSONB NOT NULL,         -- full computation spec
  update_interval_ms INTEGER NOT NULL,
  deviation_threshold_bps INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

-- Source connectors: adapter configurations
CREATE TABLE IF NOT EXISTS oracle_source_connectors (
  id TEXT PRIMARY KEY,                     -- 'lucid_gateway' | 'virtuals_acp' | ...
  protocol_id TEXT REFERENCES oracle_protocol_registry(id),
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Subscriptions: alerts and webhooks
CREATE TABLE IF NOT EXISTS oracle_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,                 -- references gateway_tenants.id
  type TEXT NOT NULL CHECK (type IN ('webhook', 'sse')),
  feed_id TEXT,                            -- null = all feeds
  threshold_json JSONB,                    -- threshold conditions
  webhook_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON oracle_subscriptions(tenant_id);

-- Seed the protocol registry with known protocols
INSERT INTO oracle_protocol_registry (id, name, chains)
VALUES
  ('lucid', 'Lucid', ARRAY['offchain', 'base', 'solana']),
  ('virtuals', 'Virtuals Protocol', ARRAY['base']),
  ('olas', 'Olas / Autonolas', ARRAY['gnosis', 'base', 'optimism'])
ON CONFLICT (id) DO NOTHING;

-- Seed V1 feed definitions
INSERT INTO oracle_feed_definitions (id, version, name, description, methodology_json, update_interval_ms, deviation_threshold_bps)
VALUES
  ('aegdp', 1, 'Agent Economy GDP', 'Total economic output across all indexed protocols',
   '{"computation": "sum(payments + tasks * avg_value + revenue)", "sources": ["lucid", "virtuals", "olas"]}',
   300000, 100),
  ('aai', 1, 'Agent Activity Index', 'Composite of active agents, tasks/sec, tool calls, unique interactions',
   '{"computation": "weighted_composite(active_agents, tasks_per_sec, tool_calls_per_sec, unique_interactions)", "sources": ["lucid", "virtuals", "olas"]}',
   300000, 200),
  ('apri', 1, 'Agent Protocol Risk Index', 'Bundled health scores, reliability tiers, error rates, concentration',
   '{"computation": "weighted_bundle(protocol_health, agent_reliability, error_rates, concentration)", "sources": ["lucid", "virtuals", "olas"]}',
   300000, 500)
ON CONFLICT (id, version) DO NOTHING;

-- Seed source connectors
INSERT INTO oracle_source_connectors (id, protocol_id, config)
VALUES
  ('lucid_gateway', 'lucid', '{"type": "internal_tap", "tables": ["receipt_events", "mcpgate_audit_log", "gateway_payment_sessions"]}')
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Verify migration**

Run: `ls migrations/`
Expected: `001_control_plane.sql` is the only migration (first migration in this repo).

- [ ] **Step 3: Validate SQL syntax**

Run: `psql "$DATABASE_URL" --dry-run -f migrations/001_control_plane.sql` or review manually.
Expected: Valid SQL, no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add migrations/001_control_plane.sql
git commit -m "feat(oracle-economy): add control plane migration — protocol registry, agent entities, feeds, subscriptions"
```

---

### Task 7: Redpanda client wrapper

**Files:**
- Create: `packages/core/src/clients/redpanda.ts`
- Create: `packages/core/src/__tests__/redpanda.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RedpandaProducer, RedpandaConsumer, TOPICS } from '../clients/redpanda.js'

// Mock kafkajs
const mockSend = vi.fn().mockResolvedValue(undefined)
const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockDisconnect = vi.fn().mockResolvedValue(undefined)
const mockSubscribe = vi.fn().mockResolvedValue(undefined)
const mockRun = vi.fn().mockResolvedValue(undefined)

vi.mock('kafkajs', () => ({
  Kafka: vi.fn(() => ({
    producer: vi.fn(() => ({
      connect: mockConnect,
      send: mockSend,
      disconnect: mockDisconnect,
    })),
    consumer: vi.fn(() => ({
      connect: mockConnect,
      subscribe: mockSubscribe,
      run: mockRun,
      disconnect: mockDisconnect,
    })),
  })),
}))

describe('RedpandaProducer', () => {
  let producer: RedpandaProducer

  beforeEach(() => {
    vi.clearAllMocks()
    producer = new RedpandaProducer({ brokers: ['localhost:9092'] })
  })

  it('throws when publishing before connect', async () => {
    await expect(producer.publishEvents(TOPICS.RAW_GATEWAY, []))
      .rejects.toThrow('Producer not connected')
  })

  it('sends events with correct key and topic after connect', async () => {
    await producer.connect()
    const event = {
      event_id: 'test-1',
      source: 'lucid_gateway',
      chain: 'offchain',
      event_timestamp: new Date('2026-03-12T00:00:00Z'),
    } as any

    await producer.publishEvents(TOPICS.RAW_GATEWAY, [event])
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: TOPICS.RAW_GATEWAY,
        messages: [expect.objectContaining({ key: 'lucid_gateway:offchain' })],
      })
    )
  })

  it('skips send for empty events array', async () => {
    await producer.connect()
    await producer.publishEvents(TOPICS.RAW_GATEWAY, [])
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('RedpandaConsumer', () => {
  it('subscribes to topics and calls connect', async () => {
    const consumer = new RedpandaConsumer({
      brokers: ['localhost:9092'],
      groupId: 'test-group',
    })
    await consumer.subscribe([TOPICS.RAW_GATEWAY])
    expect(mockConnect).toHaveBeenCalled()
    expect(mockSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ topic: TOPICS.RAW_GATEWAY })
    )
  })
})

describe('TOPICS', () => {
  it('defines all expected topics', () => {
    expect(TOPICS.RAW_GATEWAY).toBe('raw.lucid_gateway.events')
    expect(TOPICS.NORMALIZED).toBe('normalized.economic')
    expect(TOPICS.INDEX_UPDATES).toBe('index.updates')
    expect(TOPICS.PUBLICATION).toBe('publication.requests')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/__tests__/redpanda.test.ts`
Expected: FAIL with "Cannot find module '../clients/redpanda.js'"

- [ ] **Step 3: Implement Redpanda producer/consumer wrapper**

```typescript
import { Kafka, type Producer, type Consumer, type EachMessagePayload } from 'kafkajs'
import type { RawEconomicEvent } from '../types/events.js'

export interface RedpandaConfig {
  brokers: string[]
  clientId?: string
}

/** Redpanda topic names */
export const TOPICS = {
  RAW_GATEWAY: 'raw.lucid_gateway.events',
  RAW_VIRTUALS: 'raw.virtuals_acp.events',
  RAW_OLAS: 'raw.olas.events',
  RAW_ERC8004: 'raw.erc8004.events',
  RAW_AGENT_WALLETS: 'raw.agent_wallets.events',
  NORMALIZED: 'normalized.economic',
  INDEX_UPDATES: 'index.updates',
  PUBLICATION: 'publication.requests',
} as const

export class RedpandaProducer {
  private readonly kafka: Kafka
  private producer: Producer | null = null

  constructor(config: RedpandaConfig) {
    this.kafka = new Kafka({
      clientId: config.clientId ?? 'oracle-economy-producer',
      brokers: config.brokers,
    })
  }

  async connect(): Promise<void> {
    this.producer = this.kafka.producer()
    await this.producer.connect()
  }

  async publishEvents(topic: string, events: RawEconomicEvent[]): Promise<void> {
    if (!this.producer) throw new Error('Producer not connected')
    if (events.length === 0) return

    await this.producer.send({
      topic,
      messages: events.map((e) => ({
        key: `${e.source}:${e.chain}`,
        value: JSON.stringify(e),
        timestamp: e.event_timestamp.getTime().toString(),
      })),
    })
  }

  async disconnect(): Promise<void> {
    await this.producer?.disconnect()
    this.producer = null
  }
}

export class RedpandaConsumer {
  private readonly kafka: Kafka
  private consumer: Consumer | null = null

  constructor(config: RedpandaConfig & { groupId: string }) {
    this.kafka = new Kafka({
      clientId: config.clientId ?? 'oracle-economy-consumer',
      brokers: config.brokers,
    })
    this.consumer = this.kafka.consumer({ groupId: config.groupId })
  }

  async subscribe(topics: string[]): Promise<void> {
    if (!this.consumer) throw new Error('Consumer not initialized')
    await this.consumer.connect()
    for (const topic of topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false })
    }
  }

  async run(handler: (event: RawEconomicEvent, meta: { topic: string; partition: number; offset: string }) => Promise<void>): Promise<void> {
    if (!this.consumer) throw new Error('Consumer not initialized')
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        if (!message.value) return
        const event = JSON.parse(message.value.toString()) as RawEconomicEvent
        await handler(event, { topic, partition, offset: message.offset })
      },
    })
  }

  async disconnect(): Promise<void> {
    await this.consumer?.disconnect()
    this.consumer = null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/src/__tests__/redpanda.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/redpanda.ts packages/core/src/__tests__/redpanda.test.ts
git commit -m "feat(oracle-economy): add Redpanda producer/consumer wrappers with topic definitions"
```

---

## Chunk 3: Gateway Tap Adapter + Feed Computation

### Task 8: Gateway Tap adapter

**Scope:** Plan 1 implements transforms for the 3 highest-value gateway sources:
`receipt_events`, `mcpgate_audit_log`, `gateway_payment_sessions`.
Remaining sources deferred to later plans:
- `openmeter_event_ledger` → Plan 3 (metering enrichment)
- `gateway_spent_proofs` → Plan 2 (payment verification)
- `gateway_settlement_receipts` → Plan 2 (settlement)
- `gateway_quota_usage` → Plan 3 (usage analytics)
- `gateway_agent_reputation` → Plan 3 (reputation feeds)

**Files:**
- Create: `packages/core/src/adapters/gateway-tap.ts`
- Create: `packages/core/src/__tests__/gateway-tap.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
} from '../adapters/gateway-tap.js'

describe('GatewayTap', () => {
  describe('transformReceiptEvent', () => {
    it('transforms a receipt event into a RawEconomicEvent', () => {
      const receipt = {
        id: 'evt_abc123',
        tenant_id: 'tenant_demo',
        model: 'openai/gpt-4o',
        endpoint: '/v1/chat/completions',
        tokens_in: 500,
        tokens_out: 200,
        model_passport_id: null,
        compute_passport_id: null,
        created_at: '2026-03-12T10:00:00Z',
      }
      const event = transformReceiptEvent(receipt)

      expect(event.source).toBe('lucid_gateway')
      expect(event.event_type).toBe('llm_inference')
      expect(event.chain).toBe('offchain')
      expect(event.subject_raw_id).toBe('tenant_demo')
      expect(event.subject_id_type).toBe('tenant')
      expect(event.protocol).toBe('lucid')
      expect(event.model_id).toBe('gpt-4o')
      expect(event.provider).toBe('openai')
      expect(event.status).toBe('success')
      expect(event.economic_authentic).toBe(true)
      expect(event.event_id).toBeTruthy()
    })
  })

  describe('transformAuditLogEntry', () => {
    it('transforms an audit log entry into a tool_call event', () => {
      const entry = {
        id: '42',
        tenant_id: 'tenant_demo',
        server_id: 'github',
        tool_name: 'create_issue',
        status: 'success',
        duration_ms: 340,
        created_at: '2026-03-12T10:01:00Z',
      }
      const event = transformAuditLogEntry(entry)

      expect(event.event_type).toBe('tool_call')
      expect(event.tool_name).toBe('create_issue')
      expect(event.duration_ms).toBe(340)
      expect(event.status).toBe('success')
    })
  })

  describe('transformPaymentSession', () => {
    it('transforms a payment session into a payment event', () => {
      const session = {
        id: 'ps_abc',
        tenant_id: 'tenant_demo',
        token: 'USDC',
        deposit_amount: '10000000',   // 10 USDC in micro
        chain: 'base',
        tx_hash: '0xabc123',
        status: 'active',
        created_at: '2026-03-12T10:02:00Z',
      }
      const event = transformPaymentSession(session)

      expect(event.event_type).toBe('payment')
      expect(event.chain).toBe('base')
      expect(event.tx_hash).toBe('0xabc123')
      expect(event.currency).toBe('USDC')
      expect(event.amount).toBe('10000000')
      expect(event.economic_authentic).toBe(true)
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/__tests__/gateway-tap.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Gateway Tap adapter**

```typescript
import { computeEventId } from '../types/events.js'
import type { RawEconomicEvent } from '../types/events.js'

const ADAPTER_VERSION = 1

/** Transform a receipt_events row into a RawEconomicEvent */
export function transformReceiptEvent(receipt: {
  id: string
  tenant_id: string
  model: string
  endpoint: string
  tokens_in: number
  tokens_out: number
  model_passport_id: string | null
  compute_passport_id: string | null
  created_at: string
}): RawEconomicEvent {
  const [provider, ...modelParts] = receipt.model.split('/')
  const modelId = modelParts.join('/') || receipt.model

  return {
    event_id: computeEventId('lucid_gateway', 'offchain', null, null, `receipt_${receipt.id}`),
    source: 'lucid_gateway',
    source_adapter_ver: ADAPTER_VERSION,
    ingestion_type: 'realtime',
    ingestion_ts: new Date(),
    chain: 'offchain',
    block_number: null,
    tx_hash: null,
    log_index: null,
    event_type: 'llm_inference',
    event_timestamp: new Date(receipt.created_at),
    subject_entity_id: null,
    subject_raw_id: receipt.tenant_id,
    subject_id_type: 'tenant',
    counterparty_raw_id: null,
    protocol: 'lucid',
    amount: null,
    currency: null,
    usd_value: null,  // computed downstream from token counts × model pricing
    tool_name: null,
    model_id: modelId,
    provider: provider || null,
    duration_ms: null,
    status: 'success',
    quality_score: 1.0,
    economic_authentic: true,
    corrects_event_id: null,
    correction_reason: null,
  }
}

/** Transform an mcpgate_audit_log row into a RawEconomicEvent */
export function transformAuditLogEntry(entry: {
  id: string
  tenant_id: string
  server_id: string
  tool_name: string
  status: string
  duration_ms: number
  created_at: string
}): RawEconomicEvent {
  return {
    event_id: computeEventId('lucid_gateway', 'offchain', null, null, `audit_${entry.id}`),
    source: 'lucid_gateway',
    source_adapter_ver: ADAPTER_VERSION,
    ingestion_type: 'realtime',
    ingestion_ts: new Date(),
    chain: 'offchain',
    block_number: null,
    tx_hash: null,
    log_index: null,
    event_type: 'tool_call',
    event_timestamp: new Date(entry.created_at),
    subject_entity_id: null,
    subject_raw_id: entry.tenant_id,
    subject_id_type: 'tenant',
    counterparty_raw_id: null,
    protocol: 'lucid',
    amount: null,
    currency: null,
    usd_value: null,
    tool_name: entry.tool_name,
    model_id: null,
    provider: entry.server_id,
    duration_ms: entry.duration_ms,
    status: entry.status as RawEconomicEvent['status'],
    quality_score: 1.0,
    economic_authentic: entry.status === 'success',
    corrects_event_id: null,
    correction_reason: null,
  }
}

/** Transform a gateway_payment_sessions row into a RawEconomicEvent */
export function transformPaymentSession(session: {
  id: string
  tenant_id: string
  token: string
  deposit_amount: string
  chain?: string
  tx_hash?: string
  status: string
  created_at: string
}): RawEconomicEvent {
  return {
    event_id: computeEventId('lucid_gateway', session.chain ?? 'offchain', session.tx_hash ?? null, null, `payment_${session.id}`),
    source: 'lucid_gateway',
    source_adapter_ver: ADAPTER_VERSION,
    ingestion_type: 'realtime',
    ingestion_ts: new Date(),
    chain: (session.chain ?? 'offchain') as RawEconomicEvent['chain'],
    block_number: null,
    tx_hash: session.tx_hash ?? null,
    log_index: null,
    event_type: 'payment',
    event_timestamp: new Date(session.created_at),
    subject_entity_id: null,
    subject_raw_id: session.tenant_id,
    subject_id_type: 'tenant',
    counterparty_raw_id: null,
    protocol: 'lucid',
    amount: session.deposit_amount,
    currency: session.token,
    usd_value: null,  // USDC = 1:1 for now; enriched downstream
    tool_name: null,
    model_id: null,
    provider: null,
    duration_ms: null,
    status: session.status === 'active' ? 'success' : 'error',
    quality_score: 1.0,
    economic_authentic: true,
    corrects_event_id: null,
    correction_reason: null,
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/core/src/__tests__/gateway-tap.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/gateway-tap.ts packages/core/src/__tests__/gateway-tap.test.ts
git commit -m "feat(oracle-economy): add Gateway Tap adapter — transforms receipt, audit, payment events"
```

---

### Task 9: AEGDP feed computation

**Files:**
- Create: `packages/core/src/feeds/aegdp.ts`
- Create: `packages/core/src/__tests__/feed-computation.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { computeAEGDP, type AEGDPInputs } from '../feeds/aegdp.js'

describe('computeAEGDP', () => {
  it('sums payment values across protocols', () => {
    const inputs: AEGDPInputs = {
      protocol_payments_usd: { lucid: 100_000, virtuals: 500_000, olas: 200_000 },
      protocol_task_revenue_usd: { lucid: 50_000, virtuals: 80_000, olas: 20_000 },
      protocol_revenue_distributed_usd: { lucid: 10_000, virtuals: 40_000, olas: 10_000 },
    }
    const result = computeAEGDP(inputs)

    // GDP = sum of all payments + task revenue + revenue distributed
    // = (100k + 500k + 200k) + (50k + 80k + 20k) + (10k + 40k + 10k) = 1,010,000
    expect(result.value_usd).toBe(1_010_000)
    expect(result.breakdown.total_payments_usd).toBe(800_000)
    expect(result.breakdown.total_task_revenue_usd).toBe(150_000)
    expect(result.breakdown.total_revenue_distributed_usd).toBe(60_000)
  })

  it('returns zero for empty inputs', () => {
    const inputs: AEGDPInputs = {
      protocol_payments_usd: {},
      protocol_task_revenue_usd: {},
      protocol_revenue_distributed_usd: {},
    }
    const result = computeAEGDP(inputs)
    expect(result.value_usd).toBe(0)
  })

  it('includes per-protocol breakdown', () => {
    const inputs: AEGDPInputs = {
      protocol_payments_usd: { lucid: 100 },
      protocol_task_revenue_usd: { lucid: 50 },
      protocol_revenue_distributed_usd: { lucid: 10 },
    }
    const result = computeAEGDP(inputs)
    expect(result.breakdown.by_protocol.lucid).toBe(160)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/src/__tests__/feed-computation.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement AEGDP feed spec**

File: `packages/core/src/feeds/aegdp.ts`

```typescript
import { createHash } from 'node:crypto'

export interface AEGDPInputs {
  protocol_payments_usd: Record<string, number>
  protocol_task_revenue_usd: Record<string, number>
  protocol_revenue_distributed_usd: Record<string, number>
}

export interface AEGDPResult {
  value_usd: number
  breakdown: {
    total_payments_usd: number
    total_task_revenue_usd: number
    total_revenue_distributed_usd: number
    by_protocol: Record<string, number>
  }
  input_manifest_hash: string
  computation_hash: string
}

/** Deterministic AEGDP computation. Pure function. */
export function computeAEGDP(inputs: AEGDPInputs): AEGDPResult {
  const allProtocols = new Set([
    ...Object.keys(inputs.protocol_payments_usd),
    ...Object.keys(inputs.protocol_task_revenue_usd),
    ...Object.keys(inputs.protocol_revenue_distributed_usd),
  ])

  const totalPayments = sumValues(inputs.protocol_payments_usd)
  const totalTaskRevenue = sumValues(inputs.protocol_task_revenue_usd)
  const totalRevenueDistributed = sumValues(inputs.protocol_revenue_distributed_usd)

  const byProtocol: Record<string, number> = {}
  for (const p of allProtocols) {
    byProtocol[p] =
      (inputs.protocol_payments_usd[p] ?? 0) +
      (inputs.protocol_task_revenue_usd[p] ?? 0) +
      (inputs.protocol_revenue_distributed_usd[p] ?? 0)
  }

  const valueUsd = totalPayments + totalTaskRevenue + totalRevenueDistributed

  return {
    value_usd: valueUsd,
    breakdown: {
      total_payments_usd: totalPayments,
      total_task_revenue_usd: totalTaskRevenue,
      total_revenue_distributed_usd: totalRevenueDistributed,
      by_protocol: byProtocol,
    },
    input_manifest_hash: hashInputs(inputs),
    computation_hash: COMPUTATION_HASH,
  }
}

function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, v) => sum + v, 0)
}

function hashInputs(inputs: AEGDPInputs): string {
  return createHash('sha256').update(canonicalStringify(inputs)).digest('hex')
}

/** Recursive key-sorted JSON for deterministic hashing */
function canonicalStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj)
  if (typeof obj !== 'object') return JSON.stringify(obj)
  if (Array.isArray(obj)) return '[' + obj.map(v => canonicalStringify(v)).join(',') + ']'
  const sorted = Object.keys(obj as Record<string, unknown>).sort()
  const entries = sorted.map(k =>
    JSON.stringify(k) + ':' + canonicalStringify((obj as Record<string, unknown>)[k])
  )
  return '{' + entries.join(',') + '}'
}

/** Hash of this computation's source code version */
const COMPUTATION_HASH = createHash('sha256')
  .update('aegdp_v1_sum_payments_tasks_revenue')
  .digest('hex')
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/core/src/__tests__/feed-computation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/feeds/aegdp.ts packages/core/src/__tests__/feed-computation.test.ts
git commit -m "feat(oracle-economy): add AEGDP feed computation — deterministic, pure function with provenance hashes"
```

---

## Chunk 4: API Server + Integration

### Task 10: Oracle Economy API server

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/routes/v1.ts`

- [ ] **Step 1: Create app package.json**

```json
{
  "name": "@lucid/oracle-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/server.ts",
  "dependencies": {
    "@lucid/oracle-core": "workspace:*",
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "pino": "^9.0.0"
  }
}
```

- [ ] **Step 2: Create server.ts**

```typescript
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerOracleRoutes } from './routes/v1.js'

const PORT = parseInt(process.env.PORT ?? '4040', 10)

const app = Fastify({ logger: true })

await app.register(cors, {
  origin: true,
  exposedHeaders: ['X-Request-Id'],
})

// Health check
app.get('/health', async () => ({
  status: 'ok',
  service: 'oracle-economy-api',
  timestamp: new Date().toISOString(),
}))

// NOTE: Auth middleware (resolveTenantIdAsync) deferred to Plan 3.
// Plan 1 serves unauthenticated free-tier endpoints only.
registerOracleRoutes(app)

// Graceful shutdown (Railway convention)
const shutdown = async () => {
  app.log.info('Shutting down...')
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

- [ ] **Step 3: Create initial routes (feeds + health)**

File: `apps/api/src/routes/v1.ts`

```typescript
import type { FastifyInstance } from 'fastify'
import { V1_FEEDS, type FeedId, type PublishedFeedValue } from '@lucid/oracle-core'

// In-memory store for MVP (replaced by ClickHouse in production)
const latestFeedValues = new Map<string, PublishedFeedValue>()

export function registerOracleRoutes(app: FastifyInstance): void {
  // ---- GET /v1/oracle/feeds ----
  app.get('/v1/oracle/feeds', async () => {
    return {
      feeds: Object.values(V1_FEEDS).map((f) => ({
        ...f,
        latest_value: latestFeedValues.get(f.id) ?? null,
      })),
    }
  })

  // ---- GET /v1/oracle/feeds/:id ----
  app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id', async (request, reply) => {
    const { id } = request.params
    const def = V1_FEEDS[id as FeedId]
    if (!def) {
      return reply.status(404).send({ error: 'Feed not found', feed_id: id })
    }

    const latest = latestFeedValues.get(id)
    return {
      feed: def,
      latest: latest ?? null,
      methodology_url: def.methodology_url,
    }
  })

  // ---- GET /v1/oracle/feeds/:id/methodology ----
  app.get<{ Params: { id: string } }>('/v1/oracle/feeds/:id/methodology', async (request, reply) => {
    const { id } = request.params
    const def = V1_FEEDS[id as FeedId]
    if (!def) {
      return reply.status(404).send({ error: 'Feed not found', feed_id: id })
    }

    return {
      feed_id: id,
      version: def.version,
      name: def.name,
      description: def.description,
      update_interval_ms: def.update_interval_ms,
      deviation_threshold_bps: def.deviation_threshold_bps,
      confidence_formula: {
        version: 1,
        weights: {
          source_diversity_score: 0.25,
          identity_confidence: 0.20,
          data_completeness: 0.20,
          anomaly_cleanliness: 0.15,
          freshness_score: 0.10,
          revision_stability: 0.10,
        },
        note: 'All inputs normalized to [0,1] where higher = more confident',
      },
    }
  })

  // ---- GET /v1/oracle/protocols ----
  app.get('/v1/oracle/protocols', async () => {
    return {
      protocols: [
        { id: 'lucid', name: 'Lucid', chains: ['offchain', 'base', 'solana'], status: 'active' },
        { id: 'virtuals', name: 'Virtuals Protocol', chains: ['base'], status: 'pending' },
        { id: 'olas', name: 'Olas / Autonolas', chains: ['gnosis', 'base', 'optimism'], status: 'pending' },
      ],
    }
  })

  // ---- GET /v1/oracle/reports/latest ----
  app.get('/v1/oracle/reports/latest', async () => {
    const feedValues = Array.from(latestFeedValues.entries()).map(([id, v]) => ({
      feed_id: id,
      ...v,
    }))
    return {
      report: feedValues.length > 0 ? { feeds: feedValues } : null,
    }
  })
}

/** Used by feed computation worker to push new values */
export function updateFeedValue(feedId: string, value: PublishedFeedValue): void {
  latestFeedValues.set(feedId, value)
}

/** Test reset */
export function _resetFeedValues(): void {
  latestFeedValues.clear()
}
```

- [ ] **Step 4: Run npm install**

Run: `npm install`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/
git commit -m "feat(oracle-economy): add Oracle Economy API server — feeds, protocols, reports endpoints"
```

---

### Task 11: API integration tests

**Files:**
- Create: `apps/api/src/__tests__/api.test.ts`

- [ ] **Step 1: Write integration tests**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { registerOracleRoutes, _resetFeedValues } from '../routes/v1.js'

describe('Oracle Economy API', () => {
  const app = Fastify()

  beforeAll(async () => {
    registerOracleRoutes(app)
    await app.ready()
  })

  afterAll(async () => {
    _resetFeedValues()
    await app.close()
  })

  it('GET /v1/oracle/feeds returns all V1 feeds', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.feeds).toHaveLength(3)
    expect(body.feeds.map((f: any) => f.id)).toEqual(['aegdp', 'aai', 'apri'])
  })

  it('GET /v1/oracle/feeds/aegdp returns AEGDP definition', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.feed.id).toBe('aegdp')
    expect(body.feed.name).toBe('Agent Economy GDP')
  })

  it('GET /v1/oracle/feeds/nonexistent returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/nonexistent' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /v1/oracle/feeds/aegdp/methodology returns confidence formula', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp/methodology' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.confidence_formula.version).toBe(1)
    expect(body.confidence_formula.weights.source_diversity_score).toBe(0.25)
  })

  it('GET /v1/oracle/protocols returns indexed protocols', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/protocols' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.protocols.length).toBeGreaterThanOrEqual(3)
    expect(body.protocols.find((p: any) => p.id === 'lucid')).toBeTruthy()
  })

  it('GET /v1/oracle/reports/latest returns null when no feeds computed', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/oracle/reports/latest' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.report).toBeNull()
  })

  it('GET /v1/oracle/reports/latest returns data after updateFeedValue', async () => {
    const { updateFeedValue } = await import('../routes/v1.js')
    updateFeedValue('aegdp', {
      feed_id: 'aegdp',
      value: '12345.67',
      confidence: 0.85,
      completeness: 0.9,
      freshness_ms: 5000,
      staleness_risk: 'low',
      computed_at: '2026-03-12T00:00:00Z',
    } as any)

    const res = await app.inject({ method: 'GET', url: '/v1/oracle/reports/latest' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.report).not.toBeNull()
    expect(body.report.feeds).toHaveLength(1)
    expect(body.report.feeds[0].feed_id).toBe('aegdp')

    // Also verify GET /v1/oracle/feeds/aegdp returns the value
    const feedRes = await app.inject({ method: 'GET', url: '/v1/oracle/feeds/aegdp' })
    const feedBody = feedRes.json()
    expect(feedBody.latest).not.toBeNull()
    expect(feedBody.latest.value).toBe('12345.67')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run apps/api/src/__tests__/api.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/api.test.ts
git commit -m "test(oracle-economy): add API integration tests — feeds, protocols, reports, methodology"
```

---

### Task 12: Dockerfile + barrel exports

**Files:**
- Create: `Dockerfile`
- Modify: `packages/core/src/index.ts` (add all exports)

- [ ] **Step 1: Create Dockerfile**

```dockerfile
FROM node:20-slim AS base
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/

RUN npm install

COPY . .

EXPOSE ${PORT:-4040}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4040)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/api/src/server.ts"]
```

- [ ] **Step 2: Update barrel exports**

File: `packages/core/src/index.ts`

```typescript
// Types
export * from './types/index.js'

// Services
export { computeConfidence, computeFreshnessScore, computeStalenessRisk } from './services/confidence-service.js'
export { AttestationService, type ReportPayload, type ReportEnvelope } from './services/attestation-service.js'

// Feeds
export { computeAEGDP, type AEGDPInputs, type AEGDPResult } from './feeds/aegdp.js'

// Adapters
export {
  transformReceiptEvent,
  transformAuditLogEntry,
  transformPaymentSession,
} from './adapters/gateway-tap.js'

// Clients
export { OracleClickHouse, type ClickHouseConfig } from './clients/clickhouse.js'
export { RedpandaProducer, RedpandaConsumer, TOPICS, type RedpandaConfig } from './clients/redpanda.js'
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All oracle tests pass

- [ ] **Step 4: Commit**

```bash
git add Dockerfile packages/core/src/index.ts
git commit -m "feat: add Dockerfile, barrel exports — Plan 1 complete"
```

---

## Environment Variables

```bash
# Required — same Supabase instance as platform-core
DATABASE_URL=postgresql://gateway_svc:...@db.kkpgnldwrcagpgwofgqx.supabase.co:5432/postgres

# ClickHouse Cloud
CLICKHOUSE_URL=https://your-instance.clickhouse.cloud:8443
CLICKHOUSE_PASSWORD=...

# Redpanda
REDPANDA_BROKERS=localhost:9092

# Attestation
ORACLE_ATTESTATION_KEY=<hex-encoded-ed25519-private-key>  # optional, auto-generated in dev

# Server
PORT=4040
```

## Summary

After completing this plan, the `lucid-agent-oracle` repo contains:

| Component | Status |
|-----------|--------|
| `@lucid/oracle-core` package | Types, clients, adapters, services |
| Event types | RawEconomicEvent, feeds, entities, quality |
| ClickHouse client | Insert events, query rollups, get latest feed |
| Redpanda client | Producer/consumer wrappers, topic definitions |
| Gateway Tap adapter | Transform receipt, audit, payment → raw events (via DATABASE_URL) |
| Confidence scoring | Deterministic formula (versioned, tested) |
| Attestation service | Ed25519 signing, multi-signer-ready |
| AEGDP feed computation | Pure function, provenance hashes |
| Oracle Economy API | Fastify :4040, feeds/protocols/reports/methodology |
| Postgres migration | 7 control plane tables + seed data (shared Supabase) |
| Dockerfile | Railway deployment ready |
| Tests | Events, confidence, attestation, gateway-tap, API integration |

**Next: Plan 2** covers feed computation workers, MV pipeline, on-chain publication (Solana program + Base contract).
