# Plan 3B: MCP Tools — Design Specification

**Date:** 2026-03-14
**Status:** Approved for implementation planning
**Depends on:** Plan 3A v2 (complete), oracle-core attestation service, ClickHouse schema

---

## 1. Goal

Make the Lucid Agent Economy Oracle queryable by every AI agent via MCP. Ship a curated 9-tool MCP release — 6 free, 3 pro — generated from the OpenAPI spec by Speakeasy. OpenAPI is the single source of truth for REST API, MCP tools, and future SDK generation.

## 2. Architecture

```
TypeBox schemas (source of truth)
    ↓
@fastify/swagger → OpenAPI 3.0 JSON
    ↓
x-speakeasy-mcp annotations (curate which endpoints become tools)
    ↓
Speakeasy CLI → apps/mcp/ (generated MCP server)
    ↓
Thin HTTP client calling Oracle REST API
```

The MCP server is a **separate process** that calls the Oracle API over HTTP. It does not import the service layer directly. This keeps the API as the single deployment boundary for business logic. The MCP server is stateless and trivially scalable.

**Transports:** stdio (local — Claude Desktop, Cursor, etc.) + Streamable HTTP (remote — deployed on Railway). Streamable HTTP is the current MCP standard transport, replacing the older HTTP+SSE transport from the 2024-11-05 protocol revision. Legacy SSE compatibility is optional and only added if a specific client requires it.

## 3. New API Endpoints

Three new endpoints are required before MCP generation. They follow Plan 3A v2 patterns: TypeBox schemas, OpenAPI annotations, Redis cache, rate-limit config, RFC 9457 errors.

**Route file placement:**

- `apps/api/src/routes/feeds.ts` — new file for `feed_history` (feed routes currently live in `v1.ts` but new endpoints should follow the per-domain pattern from agents/protocols)
- `apps/api/src/routes/reports.ts` — new file for `verify_report`
- `apps/api/src/routes/agents.ts` — add `model_usage` to the existing agents route file

**ClickHouse access:** Currently only `v1.ts` uses ClickHouse (via startup functions, not injection). The new `feeds.ts`, `agents.ts`, and `reports.ts` routes need direct ClickHouse access. Pattern: `registerFeedRoutes(app, db, clickhouse)` / update `registerAgentRoutes(app, db, clickhouse)` / `registerReportRoutes(app, clickhouse)` — the `OracleClickHouse` instance is passed from `server.ts` at registration time, same as `db: DbClient`.

**server.ts registration ordering:** Currently ClickHouse and DB are initialized in separate conditional blocks. New route registrations should go inside the existing DB block (where `registerAgentRoutes`/`registerProtocolRoutes` are registered), since they need both `db` (for auth plugin) and `clickhouse`. The `clickhouse` variable is declared outside the DB block and is `null` when `CLICKHOUSE_URL` is not set. Routes should handle `clickhouse: OracleClickHouse | null` gracefully — if `null`, ClickHouse-backed endpoints return `has_data: false` with empty data (not 500). This matches the empty data contract in Section 6.

**TypeBox schemas:** New schemas go in:

- `apps/api/src/schemas/feeds.ts` — new file: `FeedHistoryQuery`, `FeedHistoryPoint`, `FeedHistoryResponse`
- `apps/api/src/schemas/reports.ts` — new file: `VerifyReportBody`, `VerifyReportResponse`
- `apps/api/src/schemas/agents.ts` — add: `ModelUsageQuery`, `ModelUsageEntry`, `ModelUsageResponse`

All schemas follow existing patterns: TypeBox `Type.Object()` with `$id`, `Static<typeof Schema>` for TS types.

**Redis key builders:** Add to `apps/api/src/services/redis.ts` → `keys` object:

```typescript
feedHistory: (feedId: string, period: string, interval: string, plan: string) =>
  `oracle:feed:history:${feedId}:${period}:${interval}:${plan}`,
modelUsage: (period: string, limit: number, plan: string) =>
  `oracle:model-usage:${period}:${limit}:${plan}`,
```

### 3.1 GET /v1/oracle/feeds/:id/history

**Purpose:** Time-series feed values from ClickHouse.

**Tier gating:** Free = period <= 7d. Pro/Growth = up to 90d.

**Query parameters:**

| Param | Type | Default | Values |
|-------|------|---------|--------|
| `period` | string | `'7d'` | `'1d'`, `'7d'`, `'30d'`, `'90d'` |
| `interval` | string | `'1h'` | `'1m'`, `'1h'`, `'1d'` |

**Response (200):**

```json
{
  "data": {
    "feed_id": "aegdp",
    "period": "7d",
    "interval": "1h",
    "has_data": true,
    "points": [
      {
        "timestamp": "2026-03-13T00:00:00Z",
        "value": "{\"value_usd\":12345.67}",
        "confidence": 0.85
      }
    ]
  }
}
```

**Empty result:** `has_data: false`, `points: []`. Not an error — 200 with empty data.

**`value` field format — REST vs MCP divergence:**

- **REST API:** Returns `value` as a raw JSON string (matching existing `toPublicFeedValue` in `v1.ts` which returns `row.value_json` as-is). This preserves backward compatibility with Plan 1's API contract.
- **MCP tool layer:** The `oracle_feed_history` tool MUST parse `value_json` and return structured typed fields instead of a raw string. Agents do better with structured JSON, not a JSON string they have to parse themselves. MCP tools should feel agent-native, not like thin wrappers over REST payloads. This parsing happens in the MCP server (or in a post-processing override if using Speakeasy's generated code directly).

**feed_version:** Sourced from `V1_FEEDS[feedId].version` (currently all feeds are version 1). The route validates `feedId` against `V1_FEEDS` keys — invalid IDs return 404.

**ClickHouse query:**

⚠️ **CRITICAL: Interval/period safety.** ClickHouse `toStartOfInterval` and `INTERVAL` require literal SQL interval expressions — they cannot be parameterized via `{param:Type}` bindings. The route handler MUST:

1. Whitelist allowed values: `interval` ∈ `{'1m' → 'INTERVAL 1 MINUTE', '1h' → 'INTERVAL 1 HOUR', '1d' → 'INTERVAL 1 DAY'}`, `period` ∈ `{'1d' → 'INTERVAL 1 DAY', '7d' → 'INTERVAL 7 DAY', '30d' → 'INTERVAL 30 DAY', '90d' → 'INTERVAL 90 DAY'}`
2. Map user input to SQL literals via a const lookup object (not string concatenation from user input)
3. Interpolate the mapped SQL literal into the query string

```typescript
const INTERVAL_SQL: Record<string, string> = {
  '1m': 'INTERVAL 1 MINUTE', '1h': 'INTERVAL 1 HOUR', '1d': 'INTERVAL 1 DAY',
}
const PERIOD_SQL: Record<string, string> = {
  '1d': 'INTERVAL 1 DAY', '7d': 'INTERVAL 7 DAY',
  '30d': 'INTERVAL 30 DAY', '90d': 'INTERVAL 90 DAY',
}
```

```sql
SELECT
  toStartOfInterval(computed_at, ${intervalSql}) AS timestamp,
  argMax(value_json, computed_at) AS value,
  argMax(confidence, computed_at) AS confidence
FROM published_feed_values
WHERE feed_id = {feedId:String}
  AND feed_version = {feedVersion:UInt16}
  AND computed_at >= now() - ${periodSql}
GROUP BY timestamp
ORDER BY timestamp ASC
```

Where `${intervalSql}` and `${periodSql}` are the whitelisted SQL literals (safe interpolation), and `feedId`/`feedVersion` use ClickHouse parameterized binding (matching existing `queryLatestPublishedValue` pattern in `packages/core/src/clients/clickhouse.ts`).

Uses `argMax` to pick the latest value within each interval bucket, avoiding duplicates from revisions.

**Errors:**
- 404: Feed not found (invalid feed_id)
- 403: Period exceeds tier limit

**Cache:** 60s TTL, key: `oracle:feed:history:{feed_id}:{period}:{interval}:{plan}`

**Rate limit:** 30 req/min

**Schema:** `tags: ['feeds']`, `summary: 'Get feed history'`

### 3.2 GET /v1/oracle/agents/model-usage

**Purpose:** LLM model/provider distribution across the agent economy.

**Tier:** Pro required.

**Query parameters:**

| Param | Type | Default | Values |
|-------|------|---------|--------|
| `period` | string | `'7d'` | `'1d'`, `'7d'`, `'30d'` |
| `limit` | integer | `20` | `1`-`50` |

**Response (200):**

```json
{
  "data": {
    "period": "7d",
    "has_data": true,
    "models": [
      {
        "model_id": "claude-sonnet-4-5-20250514",
        "provider": "anthropic",
        "event_count": 15420,
        "pct": 34.2
      }
    ],
    "total_events": 45100
  }
}
```

**Empty result:** `has_data: false`, `models: []`, `total_events: 0`.

**ClickHouse query:**

⚠️ Same interval safety as feed_history — `period` must be whitelisted and interpolated as a SQL literal, not parameterized. `limit` can use ClickHouse parameterized binding (`{limit:UInt32}`).

```sql
SELECT
  model_id,
  provider,
  count() AS event_count
FROM raw_economic_events
WHERE event_type = 'llm_inference'
  AND event_timestamp >= now() - ${periodSql}
  AND model_id IS NOT NULL
  AND model_id != ''
GROUP BY model_id, provider
ORDER BY event_count DESC
LIMIT {limit:UInt32}
```

`pct` is computed application-side from `event_count / total_events * 100`, rounded to 1 decimal.

**Errors:**
- 403: Free tier (requires pro)

**Cache:** 120s TTL, key: `oracle:model-usage:{period}:{limit}:{plan}`

**Rate limit:** 30 req/min

**Schema:** `tags: ['agents']`, `summary: 'Get model usage distribution'`

### 3.3 POST /v1/oracle/reports/verify

**Purpose:** Verify a signed oracle report envelope — Ed25519 signature + payload integrity.

**Tier:** Free (verification is a trust feature, should be accessible to all).

**Request body:**

The `report` field accepts the full signed report envelope as produced by `AttestationService.signReport()` (see `packages/core/src/services/attestation-service.ts`). The shape matches `ReportEnvelope`:

```json
{
  "report": {
    "feed_id": "aegdp",
    "feed_version": 1,
    "report_timestamp": 1741824000000,
    "values": { "value_usd": 12345.67 },
    "input_manifest_hash": "sha256hex",
    "computation_hash": "sha256hex",
    "revision": 0,
    "signer_set_id": "ss_lucid_v1",
    "signatures": [
      { "signer": "hex-pubkey", "sig": "hex-sig" }
    ]
  }
}
```

**Response (200):**

```json
{
  "data": {
    "valid": true,
    "checks": {
      "signature": "pass",
      "payload_integrity": "pass",
      "signer_set_id": "ss_lucid_v1",
      "signers": ["hex-pubkey"]
    },
    "publication": {
      "solana_tx": "abc123...",
      "base_tx": null
    }
  }
}
```

**Verification steps:**

1. **Signature check:** Use `AttestationService.verifyReport(envelope)` from `oracle-core` to verify Ed25519 signatures against the canonical JSON payload. The method strips `signer_set_id` and `signatures` from the envelope, canonicalizes the remaining `ReportPayload`, and verifies each signature.
2. **Payload integrity:** Derived from the signature check. If the Ed25519 signature over the canonical payload verifies, the payload has not been tampered with — signature verification IS the integrity proof. Note: `computation_hash` is the code-version hash (hash of the computation algorithm), NOT a hash of the payload data, so it cannot be used for payload integrity comparison.
3. **Publication lookup:** Look up on-chain publication status from `published_feed_values` in ClickHouse using `feed_id` + `report_timestamp`. The `report_timestamp` (epoch ms) must be converted to ISO string via `new Date(report_timestamp).toISOString()` to match the `computed_at` column format (both are derived from the same `now` in the publisher). Columns `published_solana` / `published_base` are both `String | null` — see `PublishedFeedRow` in `packages/core/src/clients/clickhouse.ts`. Return null if no on-chain publication found. **No live RPC calls** — this is a lookup against stored state only. The existing `OracleClickHouse.queryPublicationStatus(feedId, feedVersion, computedAt, revision)` method can be reused — source `feedVersion` from `V1_FEEDS[feedId].version` and `revision` from the envelope.

**Errors:**
- 400: Invalid report format (missing required fields)

**Cache:** None (POST, unique payloads).

**Rate limit:** 10 req/min (prevent abuse of crypto verification).

**Schema:** `tags: ['reports']`, `summary: 'Verify oracle report'`

## 4. MCP Tool Curation

### 4.1 The 9 Tools

| # | Tool Name | Maps To | Tier | Description |
|---|-----------|---------|------|-------------|
| 1 | `oracle_economy_snapshot` | `GET /feeds` | Free | Current state of the agent economy — all 3 feed values with confidence and freshness |
| 2 | `oracle_feed_value` | `GET /feeds/:id` + `GET /feeds/:id/methodology` | Free | Deep dive on a single feed with methodology context |
| 3 | `oracle_agent_lookup` | `GET /agents/:id` | Free | Agent profile — wallets, protocols, reputation, stats |
| 4 | `oracle_agent_search` | `GET /agents/search` | Free | Find agents by wallet, protocol, ERC-8004 ID, or name |
| 5 | `oracle_protocol_stats` | `GET /protocols` + `GET /protocols/:id` | Free | Protocol listing and detail with agent/wallet counts |
| 6 | `oracle_verify_report` | `POST /reports/verify` | Free | Verify signed oracle report — signature + integrity + publication status |
| 7 | `oracle_agent_deep_metrics` | `GET /agents/:id/metrics` + `GET /agents/:id/activity` | Pro | Full agent dossier — wallet/evidence/protocol breakdowns + activity feed |
| 8 | `oracle_feed_history` | `GET /feeds/:id/history` | Pro | Time-series feed values for trend analysis |
| 9 | `oracle_model_usage` | `GET /agents/model-usage` | Pro | LLM model/provider distribution across the agent economy |

### 4.2 Composite Tools

Tools 2, 5, and 7 combine multiple API endpoints into a single tool invocation. Speakeasy's `x-speakeasy-mcp` supports grouping operations under a single tool name. The MCP server makes multiple HTTP calls and merges the responses.

- **`oracle_feed_value`**: Calls feed detail + methodology, returns unified object
- **`oracle_protocol_stats`**: When given a protocol ID, calls detail endpoint. Without ID, calls list endpoint.
- **`oracle_agent_deep_metrics`**: Calls metrics + activity (first page), returns combined result

### 4.3 Tool Count Note

The master Oracle spec (Plan 1) described "5 free + 10+ pro" tools for the full MCP surface. This first MCP release ships **6 free + 3 pro = 9 tools** — a curated subset. The extra free tool vs the original plan is `oracle_verify_report`, added because verification is a trust feature that should be accessible to all tiers. Future waves will add more pro tools as described in Section 8.

### 4.4 Existing Route Annotations (v1.ts)

The existing feed routes in `v1.ts` (`GET /feeds`, `GET /feeds/:id`, `GET /feeds/:id/methodology`, `GET /reports/latest`) need `x-speakeasy-mcp` annotations added to their schemas. Currently these routes have minimal schema definitions. Plan 3B adds:

- OpenAPI `tags`, `summary`, `description` to all feed/report routes in `v1.ts`
- `x-speakeasy-mcp` tool annotations for included routes
- `x-speakeasy-mcp: { disabled: true }` for excluded routes (`/reports/latest`)

This is annotation-only work — no handler logic changes.

### 4.5 Excluded Endpoints

| Endpoint | Reason |
|----------|--------|
| `GET /agents/leaderboard` | Dashboard/SDK surface, not a natural agent query |
| `GET /protocols/:id/metrics` | Folded into `oracle_protocol_stats` composite |
| `GET /health` | Infrastructure |
| Identity/admin routes | Internal |

### 4.6 OpenAPI Annotations

Tools are annotated in the Fastify route schemas using Speakeasy extensions:

```typescript
// Included as tool:
schema: {
  'x-speakeasy-mcp': {
    'tool-name': 'oracle_economy_snapshot',
    description: 'Get current state of the agent economy — AEGDP, AAI, APRI feed values.',
  },
  // ... existing schema
}

// Excluded:
schema: {
  'x-speakeasy-mcp': { disabled: true },
  // ... existing schema
}
```

If TypeBox `extensions` don't propagate cleanly to the Swagger output, a post-processing step on the exported `openapi.json` adds the annotations before Speakeasy generation.

### 4.7 Speakeasy Runtime Curation

Take advantage of Speakeasy's MCP generation features beyond basic tool exposure:

- **Tool scopes** — use `x-speakeasy-mcp` scope annotations to control which tools are available per auth context (free vs pro)
- **Specific tool inclusion/exclusion** — curate via `disabled: true` rather than removing endpoints from OpenAPI, keeping the spec complete for SDK generation
- **Dynamic mode** — consider enabling progressive tool discovery so agents see available tools based on their tier without hitting 403s on tools they can't use

These are generation-time decisions that should be verified during the Speakeasy validation step (Section 5.1).

### 4.8 Composite Tool Fallback

Speakeasy's `x-speakeasy-mcp` composite tool grouping (multiple operations under one tool name) is documented but may have limitations. **Fallback:** If Speakeasy doesn't support compositing natively, implement composite tools as thin wrappers in a `apps/mcp/src/overrides/` directory that call multiple generated SDK methods and merge results. The generated server structure should allow this extension without forking. Verify composite support during the Speakeasy validation step (Section 5.1) — if it fails, switch to the wrapper approach before proceeding.

## 5. Speakeasy Integration

### 5.1 Generation Pipeline

```bash
# 1. Export OpenAPI spec from running Fastify
curl http://localhost:4040/docs/json > openapi.json

# 2. Validate spec
speakeasy validate -s openapi.json

# 3. Generate MCP server
speakeasy generate -s openapi.json -o apps/mcp -t typescript
```

### 5.2 Package Structure

```
apps/mcp/
  package.json            — @lucid/oracle-mcp
  src/
    index.ts              — Entry point (stdio + Streamable HTTP transport)
  .speakeasy/
    gen.yaml              — Generation config
speakeasy.yaml            — Root config (org: lucidflare)
openapi.json              — Build artifact (gitignored)
```

### 5.3 Speakeasy Config

```yaml
# speakeasy.yaml
configVersion: 2.0.0
generation:
  sdkClassName: LucidOracle
  targetLanguage: typescript
mcpServerOptions:
  serverName: lucid-oracle-mcp
  serverVersion: 1.0.0
```

### 5.4 Deployment

- **Local/stdio:** `npx @lucid/oracle-mcp` — agents connect via stdio (Claude Desktop, Cursor, etc.)
- **Remote/Streamable HTTP:** Deployed on Railway alongside the API, separate port. Agents connect via HTTP endpoint URL. Streamable HTTP supports request/response and optional server-initiated streaming within the same connection.
- Both transports are generated by Speakeasy. Legacy SSE fallback only if a specific client requires it.

### 5.5 API Base URL

The MCP server reads `ORACLE_API_URL` env var (defaults to `http://localhost:4040`). In production, this points to the deployed API.

API key passthrough: The MCP server forwards the connecting agent's API key (from MCP auth context or env var `ORACLE_API_KEY`) as `x-api-key` header on all API calls.

### 5.6 Remote MCP Security

The MCP transport spec warns that Streamable HTTP servers must implement proper security. The remote MCP server MUST:

1. **Validate `Origin` header** — reject requests from unexpected origins to prevent CSRF-style abuse
2. **Authenticate inbound connections** — require a valid API key before forwarding any tool calls to the Oracle API. No unauthenticated open remote access.
3. **Forward resolved API key** — pass the authenticated key as `x-api-key` to the Oracle API, inheriting the tenant's plan/tier for rate limiting and feature gating
4. **Rate-limit at the MCP layer** — independent of API-level rate limits, to prevent abuse of the MCP endpoint itself

stdio transport is inherently local and does not require Origin validation.

## 6. Empty Data Handling

ClickHouse-backed endpoints (feed_history, model_usage) may return empty results if:
- The deployment hasn't accumulated data yet
- The requested time range has no events
- The feed worker hasn't run

**Contract:**
- Always return 200 with `has_data: false` and empty arrays
- Never return 404 for empty data (404 is reserved for invalid IDs)
- Never return mock/synthetic data
- MCP tool descriptions should note that empty results mean "no data available for this period" not "error"

## 7. Testing Strategy

### 7.1 API Endpoint Tests (~15 new tests)

**`feed-history.test.ts`** (~6 tests):
- Returns time-series for valid feed_id
- Returns `has_data: false` with empty points when no data
- Rejects invalid feed_id (404)
- Free tier capped at 7d (403 for 30d/90d)
- Validates interval parameter
- Cache key includes plan tier

**`model-usage.test.ts`** (~4 tests):
- Returns model breakdown with percentages
- Returns `has_data: false` when empty
- Requires pro tier (403 for free)
- Respects limit parameter

**`verify-report.test.ts`** (~5 tests):
- Valid report passes all checks
- Tampered signature fails
- Tampered payload fails integrity check
- Returns publication tx hashes when available
- Returns null publication when no on-chain data

### 7.2 OpenAPI Spec Validation

Build step: export spec → `speakeasy validate` → verify all 9 tool annotations present, excluded endpoints disabled. Runs as CI check.

### 7.3 MCP Server Smoke Test

Post-generation: `npx @modelcontextprotocol/inspector` against generated server. Verify 9 tools listed with correct schemas. Manual/CI verification.

### 7.4 Test Targets

- New API tests: ~15
- Existing tests: 242
- Total target: **257+**

## 8. Scope Boundaries

### In scope (Plan 3B)

- 3 new API endpoints (feed_history, model_usage, verify_report)
- OpenAPI `x-speakeasy-mcp` annotations on all route schemas
- Speakeasy-generated MCP server (`apps/mcp/`)
- 9 curated tools (6 free + 3 pro)
- ~15 new tests

### Out of scope (future waves)

- **Wave 2:** `oracle_tool_popularity`, `oracle_cost_index`, `oracle_chain_heatmap`
- **Wave 3:** `oracle_set_alert`, `oracle_demand_signals`, `oracle_raw_query`
- **Plan 3C:** TypeScript SDK (`@lucidai/oracle`)
- **Plan 3D:** Dashboard (Next.js)
- **Plan 3E:** SSE streaming + webhook alerts
