# Lucid Agent Economy Oracle

## What This Is

Cross-protocol economic data layer for the agent economy. Indexes agent activity across Lucid, Virtuals, Olas, ERC-8004, and on-chain wallets. Computes verifiable economic indexes. Publishes signed oracle feeds on Solana and Base.

## Monorepo Structure

```
packages/core/       — Shared types, feeds, ClickHouse client, attestation, adapters, verifiers
apps/api/            — Fastify REST API (:4040) — feeds, agents, protocols, identity
apps/worker/         — Feed computation worker (poll → ingest → compute → publish)
apps/publisher/      — On-chain publication (Solana + Base)
apps/ponder/         — EVM indexer (Ponder) for ERC-8004 + Base events
```

## Commands

```bash
npm run dev          # Start API server (tsx apps/api/src/server.ts)
npm test             # Run all tests (vitest run) — needs CURSOR_SECRET env
npm run typecheck    # TypeScript check (tsc --noEmit)
```

Required env for tests: `CURSOR_SECRET=any-secret-value`

### MCP Generation (Plan 3B)

```bash
npm run dev                     # Start API server
curl http://localhost:4040/docs/json > openapi.json
npx tsx scripts/annotate-openapi.ts openapi.json
speakeasy validate -s openapi.json
speakeasy generate -s openapi.json -o apps/mcp -t typescript
```

## Tech Stack

- **Runtime:** Node.js, TypeScript (ESM, .js extensions in imports)
- **API:** Fastify 5, TypeBox 0.34 (schemas + OpenAPI), @fastify/swagger
- **Database:** Postgres (pg), ClickHouse, Redis (node-redis v4)
- **Streaming:** Redpanda (Kafka-compatible via kafkajs)
- **On-chain:** Solana (Ed25519), Base (Foundry/Solidity)
- **Testing:** Vitest

## Architecture

Four planes: Data (ClickHouse + Redpanda), Control (Postgres), Publication (Solana + Base), Product (API + MCP + SDK + Dashboard).

### API Plugin Order (matters)

`onRequest(auth)` → `onRequest(rate-limit)` → `preHandler(cache)` → handler → `onSend(cache)`

Plugins registered: auth → rate-limit → cache. Auth decorates `request.tenant: { id, plan }`. Cache only acts on routes with `config.cache`. Rate-limit only on routes with `config.rateLimit` (`global: false`).

### Auth / Tiering

Server-side API key resolution via `x-api-key` header → `gateway_tenants` table → Redis cache (5min TTL). Plans: `free` (0), `pro` (1), `growth` (2). `requireTier('pro')` preHandler for gated endpoints.

### Error Format

All errors use RFC 9457 Problem Details (`application/problem+json`). Use `sendProblem()` from `schemas/common.ts`. Global error handler catches Ajv validation, rate-limit 429s, and unhandled exceptions.

### Cursor Pagination

HMAC-SHA256 signed cursors (base64url). `encodeCursor(sortValue, id)` / `decodeCursor(cursor)`. Requires `CURSOR_SECRET` env var. Supports dual-key rotation via `CURSOR_SECRET_PREV`.

### Redis Cache Keys

All in `services/redis.ts` → `keys` object. Leaderboard uses versioned namespace (`oracle:lb:v{N}:...`). Version incremented on write events via `invalidateAgentCaches()` / `invalidateProtocolCaches()`.

## Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Plan 1 | Done | Data + Control plane, ClickHouse, Redpanda, core types |
| Plan 2A | Done | Feed worker pipeline (poll → ingest → compute → publish) |
| Plan 2B | Done | On-chain publication (Solana pull oracle + Base MVR push) |
| Plan 3A | Done | API expansion — 8 endpoints (agents + protocols) |
| Plan 3A v2 | Done | API product layer — TypeBox, Swagger, Redis, auth, rate-limit, cursors, RFC 9457 |
| Plan 4A | Done | External adapters + identity resolution (pluggable registry) |
| Plan 4B | Done | Self-registration + identity evidence + conflict review |
| Plan 3B | Done (API) | MCP tools — 3 new endpoints + OpenAPI annotations + Speakeasy config (MCP generation pending Task 14) |
| Plan 3C | Planned | SDK (`@lucidai/oracle` TypeScript client) |
| Plan 3D | Planned | Dashboard (Next.js in LucidMerged) |
| Plan 3E | Planned | SSE streaming + webhook alerts |

## Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/server.ts` | API entry point — Fastify + plugins + routes |
| `apps/api/src/services/agent-query.ts` | All agent/protocol DB queries |
| `apps/api/src/services/redis.ts` | Redis singleton, cache keys, invalidation |
| `apps/api/src/schemas/common.ts` | Shared TypeBox schemas, `sendProblem()`, global error handler |
| `apps/api/src/schemas/agents.ts` | TypeBox schemas for 5 agent endpoints |
| `apps/api/src/schemas/protocols.ts` | TypeBox schemas for 3 protocol endpoints |
| `apps/api/src/plugins/auth.ts` | API key auth + `requireTier()` |
| `apps/api/src/plugins/cache.ts` | Redis response cache |
| `apps/api/src/plugins/rate-limit.ts` | Per-route rate limiting (in-memory, not Redis) |
| `apps/api/src/utils/cursor.ts` | HMAC-SHA256 signed cursor encode/decode |
| `packages/core/src/index.ts` | Core exports — feeds, adapters, verifiers, types |

## Conventions

- ESM with `.js` extensions in all imports (TypeScript compiled/run via tsx)
- TypeBox for schema definitions (single source of truth: validation + serialization + OpenAPI + TS types)
- `fastify-plugin` (fp) for plugins that need encapsulation breaking
- Service layer pattern: thin route handlers delegate to `AgentQueryService`
- Test files: `src/__tests__/*.test.ts`, mocked DB via `vi.fn()`
- Commits: `feat(scope):`, `fix(scope):`, `chore(scope):`, `docs(scope):`

## Specs & Plans

- Master spec: `docs/specs/2026-03-12-agent-economy-oracle-design.md`
- Per-phase specs: `docs/specs/2026-03-12-agent-economy-oracle-plan{N}-*.md`
- Per-phase plans: `docs/plans/2026-03-12-agent-economy-oracle-plan{N}-*.md`
- Plan 3A v2 spec: `docs/superpowers/specs/2026-03-13-plan3a-api-product-layer-design.md`
- Plan 3A v2 plan: `docs/superpowers/plans/2026-03-13-plan3a-api-product-layer.md`
