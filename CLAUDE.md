# Lucid Agent Economy Oracle

## What This Is

Cross-protocol economic data layer for the agent economy. Indexes agent activity across Lucid, Virtuals, Olas, ERC-8004, and on-chain wallets. Computes verifiable economic indexes. Publishes signed oracle feeds on Solana and Base.

## Production

**Live API:** `https://oracle-api-production-94f8.up.railway.app`

```bash
curl https://oracle-api-production-94f8.up.railway.app/health
curl https://oracle-api-production-94f8.up.railway.app/v1/oracle/feeds
curl https://oracle-api-production-94f8.up.railway.app/v1/oracle/feeds/aai/methodology
curl https://oracle-api-production-94f8.up.railway.app/docs  # Swagger UI
```

**Railway project:** Lucid Cloud (`da21f3b0-4673-4ece-9f79-b1c5dc4fd7ca`)
**GitHub repo:** `lucid-fdn/lucid-agent-oracle` (auto-deploys on push to main)

### Services

| Service | Dockerfile | Railway Status |
|---------|-----------|---------------|
| `oracle-api` | `Dockerfile.oracle` | Running — serves 19 API endpoints + enrichers |
| `oracle-worker` | `Dockerfile.worker` | Running — computes feeds every 30s |
| `oracle-webhook-worker` | `Dockerfile.webhook-worker` | Running — webhook delivery |
| `Oracle Redis` | Railway-native | Running — cache, SSE, webhooks |
| `oracle-clickhouse` | Docker image (24.8-alpine) | Running — OLAP storage |

**Enrichers** run inside the `oracle-api` process (balance, DeFi, NFT, ENS, Olas, gas, contracts, economy metrics). Each enricher uses advisory locks and configurable poll intervals. They start automatically when the corresponding API key env vars are set (e.g., `MORALIS_API_KEY`, `BASE_RPC_URL`).

### Infrastructure

| Component | Provider | Details |
|-----------|----------|---------|
| **Postgres** | Supabase (Lucid Cloud `kkpgnldwrcagpgwofgqx`) | Shared DB with Gateway, tables prefixed `oracle_*` |
| **ClickHouse** | Railway Docker (oracle-clickhouse) | Database: `oracle_economy`, 4 tables |
| **Redis** | Railway-native (Oracle Redis) | Managed, persistent, backups |
| **Streaming** | Optional (Redpanda/Kafka) | Not deployed — set `REDPANDA_BROKERS` to enable |

### Event Streaming Architecture

Redpanda/Kafka is **optional**. Without it:
- Worker computes → writes to ClickHouse (source of truth)
- API backfills from ClickHouse on startup
- SSE/webhooks use Redis Pub/Sub + Streams (Plan 3E EventBus)

When needed later, plug in **Upstash Kafka** or **Confluent Cloud** — just set `REDPANDA_BROKERS` env var. The EventBus abstraction and all consumer code is ready.

## Monorepo Structure

```
packages/core/       — Shared types, feeds, ClickHouse client, attestation, adapters, verifiers, metrics
apps/api/            — Fastify REST API (:4040) — 19 endpoints (feeds, agents, protocols, identity, alerts, SSE)
apps/worker/         — Feed computation worker (poll → ingest → compute → publish)
apps/publisher/      — On-chain publication (Solana + Base)
apps/ponder/         — EVM indexer (Ponder) for ERC-8004 + Base events
apps/webhook-worker/ — Webhook delivery worker (Redis Streams consumer, retry backoff)
apps/mcp/            — MCP server (Speakeasy-generated, 12 tools)
infra/otel/          — OpenTelemetry Collector + Tempo + Prometheus + Grafana configs
migrations/          — ClickHouse + Supabase SQL migrations
.github/workflows/   — CI/CD pipeline (typecheck + test + docker build)
```

## Commands

```bash
npm run dev          # Start API server (tsx apps/api/src/server.ts)
npm test             # Run all tests (vitest run, 421 tests) — needs CURSOR_SECRET env
npm run typecheck    # TypeScript check (tsc --noEmit)
```

Required env for tests: `CURSOR_SECRET=any-secret-value`

### Docker Compose (local dev stack)

```bash
cp .env.example .env           # Set secrets
docker compose up -d           # Start infra + services + Grafana
docker compose up -d postgres clickhouse redis  # Infra only
docker compose logs -f api     # Tail API logs
# Grafana: http://localhost:3001 (anonymous admin)
# Prometheus: http://localhost:9090
```

### SDK Generation (Plan 3C)

```bash
# SDK repo: lucid-fdn/oracle-sdk-node (19 methods + SSE helper + webhook verify)
# npm: @lucid-fdn/oracle

# Re-generate after API spec changes:
CURSOR_SECRET=test STREAM_TOKEN_SECRET=test npx tsx scripts/export-openapi.ts > openapi.json
cp openapi.json ../oracle-sdk-node/openapi/openapi.json
cd ../oracle-sdk-node && speakeasy run
npx tsc  # Compile (speakeasy compile may fail on Windows — oxlint issue)
```

**SDK resource groups:** `feeds`, `agents`, `protocols`, `reports`, `alerts`, `stream`
**Custom utilities:** `src/custom/stream.ts` (SSE EventSource helper), `src/custom/verify.ts` (webhook HMAC verification)

## Tech Stack

- **Runtime:** Node.js 20, TypeScript (ESM, .js extensions in imports)
- **API:** Fastify 5, TypeBox 0.34 (schemas + OpenAPI), @fastify/swagger
- **Database:** Postgres (Supabase Lucid Cloud), ClickHouse (Railway Docker), Redis (Railway-native)
- **Streaming:** Optional Redpanda/Kafka (via kafkajs) — EventBus abstracts to Redis when unavailable
- **On-chain:** Solana (Ed25519), Base (Foundry/Solidity)
- **Attestation:** Ed25519 single-signer + multi-signer (N-of-M quorum with SignerSetRegistry)
- **Observability:** OpenTelemetry (auto-instrumented Fastify/pg/redis) + 15 custom metrics
- **Testing:** Vitest (421 tests, 65 files)
- **CI/CD:** GitHub Actions (typecheck + test + docker build on push/PR)

## Architecture

Four planes: Data (ClickHouse), Control (Postgres/Supabase), Publication (Solana + Base), Product (API + MCP + SDK + Dashboard).

### Data Flow

```
Gateway tables (receipt_events, mcpgate_audit_log, gateway_payment_sessions)
  → Worker polls (checkpoint-based, incremental)
    → ClickHouse (raw_economic_events + metric_rollups_1m)
      → Compute AEGDP/AAI/APRI (deterministic pure functions)
        → ClickHouse (published_feed_values)
          → API serves (backfilled on startup)
            → SSE/Webhooks (via Redis EventBus)
```

### API Plugin Order (matters)

`onRequest(auth)` → `onRequest(rate-limit)` → `preHandler(cache)` → handler → `onSend(cache)`

### Auth / Tiering

API key via `x-api-key` header → `gateway_tenants` table → Redis cache (5min TTL). Plans: `free` (0), `pro` (1), `growth` (2). `requireTier('pro')` preHandler for gated endpoints.

### API Endpoints (19)

| Group | Endpoints |
|-------|-----------|
| Feeds (4) | list, get, methodology, history |
| Agents (6) | search, get, metrics, activity, leaderboard, model-usage |
| Protocols (3) | list, get, metrics |
| Reports (2) | latest, verify |
| Streaming (2) | stream token (POST), SSE stream (GET) |
| Alerts (3) | create, list, delete |

### Multi-Signer Attestation

- `AttestationService` — single Ed25519 signer (backward compatible)
- `MultiSignerAttestationService` — N signers, produces N signatures
- `SignerSetRegistry` — named groups with quorum thresholds
- Verification deduplicates by signer pubkey (prevents replay)
- `fromEnv()` factory: `ORACLE_ATTESTATION_KEYS=key1,key2,key3` or single `ORACLE_ATTESTATION_KEY`

### Database Schema

**Supabase (Lucid Cloud `kkpgnldwrcagpgwofgqx`):** 23 tables prefixed `oracle_*`
- `oracle_agent_entities`, `oracle_wallet_mappings`, `oracle_identity_links`
- `oracle_identity_evidence`, `oracle_identity_conflicts`, `oracle_registration_challenges`
- `oracle_feed_definitions`, `oracle_protocol_registry`, `oracle_source_connectors`
- `oracle_subscriptions`, `oracle_webhook_deliveries`, `oracle_worker_checkpoints`
- `oracle_wallet_transactions`, `oracle_token_registry`, `oracle_price_observations`, `oracle_position_ledger`, `oracle_agent_feedback`
- `oracle_wallet_balances`, `oracle_economy_snapshots`, `oracle_defi_positions`, `oracle_nft_holdings`
- `oracle_name_resolution`, `oracle_gas_metrics`, `oracle_contract_interactions`

**ClickHouse (database: `oracle_economy`):** 4 objects
- `raw_economic_events` — all ingested events (partitioned by month)
- `metric_rollups_1m` — 1-minute aggregates (AggregatingMergeTree)
- `metric_rollups_1m_mv` — materialized view feeding rollups
- `published_feed_values` — computed feed values (ReplacingMergeTree)

### Observability

- **Auto-instrumented:** Fastify, pg, redis, HTTP (via @opentelemetry/sdk-node)
- **Custom metrics:** feed computation, SSE connections, webhook delivery, worker cycles, EventBus
- **Local stack:** OTel Collector → Tempo (traces) + Prometheus (metrics) + Grafana (dashboards)
- **Config:** `infra/otel/` — collector, tempo, prometheus, grafana datasources

## Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Plan 1 | Done | Data + Control plane, ClickHouse, core types |
| Plan 2A | Done | Feed worker pipeline (poll → ingest → compute → publish) |
| Plan 2B | Done | On-chain publication (Solana pull oracle + Base MVR push) |
| Plan 3A | Done | API expansion — 8 endpoints (agents + protocols) |
| Plan 3A v2 | Done | API product layer — TypeBox, Swagger, Redis, auth, rate-limit, cursors, RFC 9457 |
| Plan 4A | Done | External adapters + identity resolution (pluggable registry) |
| Plan 4B | Done | Self-registration + identity evidence + conflict review |
| Plan 3B | Done | MCP tools — 3 new endpoints + OpenAPI annotations + Speakeasy MCP server (12 tools) |
| Plan 3C | Done | SDK (`@lucid-fdn/oracle` — 19 methods + SSE helper + webhook verify) |
| Plan 3D | Done | Dashboard (Next.js in LucidMerged — extraction-ready `(oracle)/` route group) |
| Plan 3E | Done | SSE streaming + webhook alerts (EventBus, Redis Pub/Sub + Streams, webhook-worker) |
| Infra | Done | Docker Compose, CI/CD, OTel, Railway deployment, Supabase migration |
| Multi-signer | Done | N-of-M quorum attestation with SignerSetRegistry |
| E2E tests | Done | 20 pipeline tests (compute → cache → serve → error paths → stale rejection) |
| ERC-8004 Indexer | Done | Ponder indexer for Identity Registry + Reputation Registry on Base |
| Subgraph Ingester | Done | Bulk ERC-8004 agent ingestion via The Graph subgraphs (5 chains, 110K+ agents) |
| Wallet Resolution | Done | MetadataSet agentWallet decoding, URI resolver, on-chain proof mapping |
| TX Harvester | Done | All ERC-20 transfers for agent wallets (Base via QuickNode, Solana via Helius) |
| Trading Classification | Done | Heuristic swap detection + Moralis high-accuracy reclassification |
| Position Ledger | Done | FIFO cost basis matching for realized execution deltas |
| Balance Enricher | Done | Token balances per wallet via Moralis (5min cycle) |
| DeFi Enricher | Done | DeFi positions via Moralis (30min cycle) |
| NFT Enricher | Done | NFT holdings via Moralis (30min cycle) |
| ENS Resolver | Done | ENS/Basename resolution via Moralis + Base RPC |
| Olas Enricher | Done | Marketplace metadata scraping (images, descriptions) |
| Gas Metrics | Done | Activity intensity from transaction counts |
| Contract Analyzer | Done | Top contract interactions per agent |
| Economy Metrics | Done | Hourly economy snapshots (portfolio value, volume, agents) |
| Agent Graph | Done | Agent-to-agent transaction discovery endpoint |
| Enricher Infra | Done | Shared utilities (withAdvisoryLock, processBatch, fetchMoralis, chain config) |
| Dashboard Phase A | Done | Economy overview, leaderboard tabs, enriched agent profile, activity pulse |
| Dashboard Phase B | Done | Network page, comparison mode, ENS/gas/contract UI, share button |
| Dashboard Phase C | Done | Force graph, particle hero, animated counters, reputation gauge, OG cards |

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/server.ts` | API entry point — Fastify + plugins + routes + OTel |
| `apps/api/src/telemetry.ts` | OpenTelemetry bootstrap (lazy, fail-safe) |
| `apps/api/src/services/agent-query.ts` | All agent/protocol DB queries |
| `apps/api/src/services/redis.ts` | Redis singleton, cache keys, Pub/Sub, Streams |
| `apps/api/src/services/event-bus.ts` | EventBus — dual fanout (SSE + webhooks) |
| `apps/api/src/routes/stream.ts` | SSE endpoint + JWT stream token auth |
| `apps/api/src/routes/alerts.ts` | Webhook alert CRUD (create/list/delete) |
| `apps/api/src/utils/crypto.ts` | AES-256-GCM encryption, HMAC signing, SSRF validation |
| `apps/api/src/plugins/auth.ts` | API key auth + `requireTier()` |
| `apps/worker/src/index.ts` | Worker entry — poll loop with advisory lock |
| `apps/worker/src/cycle.ts` | Single cycle: poll → ingest → compute → publish |
| `apps/worker/src/publisher.ts` | Feed attestation + ClickHouse persist + optional Redpanda fanout |
| `apps/webhook-worker/src/index.ts` | Webhook consumer (Redis Streams + XREADGROUP) |
| `packages/core/src/services/attestation-service.ts` | Ed25519 signing — single + multi-signer + SignerSetRegistry |
| `packages/core/src/metrics.ts` | 15 custom OTel metrics (feeds, SSE, webhooks, worker, API) |
| `packages/core/src/index.ts` | Core barrel exports |
| `packages/core/src/adapters/chains.ts` | Chain configuration (Base, Ethereum, Polygon, BSC, Monad, Solana) with subgraph URLs |
| `packages/core/src/adapters/subgraph-ingester.ts` | Bulk ERC-8004 agent ingestion via The Graph subgraphs (5 EVM chains) |
| `packages/core/src/adapters/enricher-utils.ts` | Shared enricher utilities (lock, batch, loop, fetch) |
| `packages/core/src/adapters/balance-enricher.ts` | Token balance enrichment via Moralis |
| `packages/core/src/adapters/economy-metrics.ts` | Hourly economy snapshot computation |
| `packages/core/src/adapters/base-tx-harvester.ts` | Base ERC-20 transfer indexing |
| `packages/core/src/adapters/solana-tx-harvester.ts` | Solana transaction indexing via Helius |
| `apps/api/src/routes/economy.ts` | Economy metrics API endpoints |
| `.github/workflows/ci.yml` | CI: typecheck + test + docker build |
| `docker-compose.yml` | Local dev stack (all infra + services + Grafana) |
| `Dockerfile.oracle` | Railway: API service |
| `Dockerfile.worker` | Railway: feed computation worker |
| `Dockerfile.webhook-worker` | Railway: webhook delivery worker |

## Conventions

- ESM with `.js` extensions in all imports (TypeScript compiled/run via tsx)
- TypeBox for schema definitions (single source of truth: validation + serialization + OpenAPI + TS types)
- `fastify-plugin` (fp) for plugins that need encapsulation breaking
- Service layer pattern: thin route handlers delegate to `AgentQueryService`
- SQL table names prefixed `oracle_*` (shared Supabase project with Gateway)
- Test files: `src/__tests__/*.test.ts`, mocked DB via `vi.fn()`
- Commits: `feat(scope):`, `fix(scope):`, `chore(scope):`, `docs(scope):`
- Non-root Docker (appuser:appgroup uid 1001)
- `npm ci` for reproducible builds

## Environment Variables

### Required (all services)
| Var | Used By | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | API, worker, webhook-worker | Supabase Postgres (Lucid Cloud) |
| `CURSOR_SECRET` | API | HMAC-SHA256 signed cursor pagination |

### Required (API)
| Var | Purpose |
|-----|---------|
| `STREAM_TOKEN_SECRET` | JWT signing for SSE stream tokens |
| `WEBHOOK_SECRET_KEY` | AES-256-GCM encryption for webhook secrets |

### Required (worker)
| Var | Purpose |
|-----|---------|
| `CLICKHOUSE_URL` | ClickHouse HTTP endpoint |
| `CLICKHOUSE_PASSWORD` | ClickHouse auth |
| `ORACLE_ATTESTATION_KEY` | Ed25519 private key (hex, 64 chars) |

### Optional
| Var | Default | Purpose |
|-----|---------|---------|
| `REDIS_URL` | — | Redis connection (cache, SSE, webhooks) |
| `REDPANDA_BROKERS` | — | Kafka brokers (event streaming, currently disabled) |
| `OTEL_ENABLED` | `true` | Set `false` to disable OpenTelemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTel collector endpoint |
| `POLL_INTERVAL_MS` | `300000` | Worker poll interval |
| `COMPUTATION_WINDOW_MS` | `3600000` | Feed computation window (1h) |
| `MORALIS_API_KEY` | — | Moralis API for balances, NFTs, DeFi, ENS, swap classification |
| `BASE_RPC_URL` | — | QuickNode RPC for Base TX harvesting + ENS resolution |
| `HELIUS_API_KEY` | — | Helius API for Solana TX harvesting |

## Remotes & Repos

| Repo | Purpose |
|------|---------|
| `lucid-fdn/lucid-agent-oracle` | This repo — API, worker, webhook-worker, core |
| `lucid-fdn/oracle-sdk-node` | TypeScript SDK (`@lucid-fdn/oracle`) |
| `lucid-fdn/lucid-cloud` | Platform core (Gateway, TrustGate — shared Supabase DB) |
| `lucid-fdn/LucidMerged` | Main platform (dashboard will live here in `(oracle)/` route group) |

## Specs & Plans

- Master spec: `docs/specs/2026-03-12-agent-economy-oracle-design.md`
- Per-phase specs: `docs/specs/2026-03-12-agent-economy-oracle-plan{N}-*.md`
- Plan 3E spec: `docs/superpowers/specs/2026-03-16-plan3e-sse-webhooks-design.md`
