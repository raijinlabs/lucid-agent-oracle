# Plan 3A: API Expansion — Agents as First-Class Noun

**Date:** 2026-03-12
**Status:** In Progress
**Authors:** RaijinLabs + Claude
**Parent spec:** `docs/specs/2026-03-12-agent-economy-oracle-design.md`
**Depends on:** Plan 4B (Self-Registration + Identity Evidence)
**Unlocks:** Dashboard (§10), SDK (`@lucidai/oracle`), MCP Tools (§9.3)

---

## 1. Goal

Expose agent entities as a queryable, searchable, ranked first-class resource in the Oracle API. Plan 4A+4B populated the identity tables; Plan 3A makes them consumable.

Plan 3A adds:
- **Agent profile endpoint** — full identity view: wallets, protocols, evidence, reputation
- **Agent search** — find agents by wallet address, protocol ID, ERC-8004 token ID, or display name
- **Agent leaderboard** — ranked lists by wallet count, protocol count, evidence strength, recency
- **Agent metrics** — per-agent statistics: wallet distribution, evidence breakdown, conflict history
- **Agent activity** — recent identity events: registrations, conflicts, evidence additions
- **Enhanced protocol endpoints** — dynamic protocol detail and metrics from Postgres (replacing hardcoded list)

**Design principle:** Postgres-first. All endpoints serve from the existing identity tables (agent_entities, wallet_mappings, identity_links, identity_evidence, identity_conflicts). ClickHouse-backed revenue/cost metrics, Redis hot cache, and SSE streaming are deferred to Plan 3B.

---

## 2. Architecture

### 2.1 Service Layer

A single `AgentQueryService` class encapsulates all read queries. Routes delegate to the service; tests mock the DB client.

```
┌──────────────────────────────────┐
│  Fastify Routes                  │
│  agents.ts    protocols.ts       │
│                                  │
│  ┌────────────────────────────┐  │
│  │  AgentQueryService         │  │
│  │  - getProfile(id)          │  │
│  │  - search(params)          │  │
│  │  - leaderboard(params)     │  │
│  │  - getMetrics(id)          │  │
│  │  - getActivity(id, params) │  │
│  │  - getProtocol(id)         │  │
│  │  - getProtocolMetrics(id)  │  │
│  └────────────────────────────┘  │
│              │                   │
│         DbClient                 │
│         (Postgres)               │
└──────────────────────────────────┘
```

### 2.2 Endpoint Summary

| Method | Endpoint | Description | Tier |
|--------|----------|-------------|------|
| GET | `/v1/oracle/agents/:id` | Agent profile: wallets, protocols, evidence summary, reputation | Free |
| GET | `/v1/oracle/agents/:id/metrics` | Wallet distribution, evidence breakdown, conflict stats | Pro |
| GET | `/v1/oracle/agents/:id/activity` | Recent identity events (evidence, conflicts, links) | Pro |
| GET | `/v1/oracle/agents/search` | Search by wallet, protocol, ERC-8004, display name | Free |
| GET | `/v1/oracle/agents/leaderboard` | Ranked agent list | Free |
| GET | `/v1/oracle/protocols/:id` | Protocol detail with agent count, wallet stats | Free |
| GET | `/v1/oracle/protocols/:id/metrics` | Protocol metrics: agents by link type, wallets by chain | Pro |

### 2.3 Tiering

Plan 3A implements tier awareness at the route level. For now, tiering is enforced via a simple `X-Api-Tier` header (set by upstream gateway or defaulting to `free`). The middleware pattern is:

```typescript
const tier = (request.headers['x-api-tier'] as string) ?? 'free'
if (tier === 'free') {
  return reply.status(403).send({ error: 'Pro tier required', upgrade_url: '...' })
}
```

Full API key + plan lookup is deferred to Plan 3B (gateway integration).

---

## 3. Agent Endpoints

### 3.1 GET /v1/oracle/agents/:id

Returns the full agent profile.

**Response:**
```json
{
  "agent": {
    "id": "ae_7f3k9x2m",
    "display_name": "Agent X",
    "erc8004_id": "123",
    "lucid_tenant": "tenant_abc",
    "reputation": { "score": 85, "updated_at": "2026-03-12T..." },
    "wallets": [
      { "chain": "base", "address": "0x...", "link_type": "self_claim", "confidence": 1.0 },
      { "chain": "solana", "address": "7xK...", "link_type": "lucid_passport", "confidence": 1.0 }
    ],
    "protocols": [
      { "protocol": "lucid", "protocol_id": "tenant_abc", "link_type": "gateway_correlation", "confidence": 1.0 },
      { "protocol": "erc8004", "protocol_id": "123", "link_type": "erc8004_tba", "confidence": 1.0 }
    ],
    "stats": {
      "wallet_count": 2,
      "protocol_count": 2,
      "evidence_count": 5
    },
    "created_at": "2026-03-12T00:00:00.000Z",
    "updated_at": "2026-03-12T00:00:00.000Z"
  }
}
```

**SQL:** Three queries (parallelizable):
1. `SELECT * FROM agent_entities WHERE id = $1`
2. `SELECT chain, address, link_type, confidence FROM wallet_mappings WHERE agent_entity = $1 AND removed_at IS NULL`
3. `SELECT protocol, protocol_id, link_type, confidence FROM identity_links WHERE agent_entity = $1`

Plus an aggregate:
4. `SELECT COUNT(*) FROM identity_evidence WHERE agent_entity = $1 AND revoked_at IS NULL`

**404** if entity not found.

### 3.2 GET /v1/oracle/agents/search

Search agents by various criteria.

**Query params:**
- `wallet` — address (case-insensitive match on wallet_mappings)
- `chain` — filter wallet search by chain
- `protocol` — protocol name (identity_links.protocol)
- `protocol_id` — protocol-specific ID
- `erc8004_id` — ERC-8004 token ID (agent_entities.erc8004_id)
- `q` — display name text search (ILIKE)
- `limit` — max results (default 20, max 100)
- `offset` — pagination offset (default 0)

**Response:**
```json
{
  "agents": [
    {
      "id": "ae_7f3k9x2m",
      "display_name": "Agent X",
      "erc8004_id": "123",
      "wallet_count": 2,
      "protocol_count": 2,
      "created_at": "2026-03-12T..."
    }
  ],
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

**Validation:** At least one search parameter required. Returns 400 if no criteria given.

### 3.3 GET /v1/oracle/agents/leaderboard

Ranked agent list.

**Query params:**
- `sort` — `wallet_count` (default), `protocol_count`, `evidence_count`, `newest`
- `limit` — max results (default 20, max 100)
- `offset` — pagination offset (default 0)

**Response:**
```json
{
  "agents": [
    {
      "id": "ae_7f3k9x2m",
      "display_name": "Agent X",
      "rank": 1,
      "wallet_count": 5,
      "protocol_count": 3,
      "evidence_count": 10,
      "created_at": "2026-03-12T..."
    }
  ],
  "sort": "wallet_count",
  "total": 42,
  "limit": 20,
  "offset": 0
}
```

**SQL:** Uses LEFT JOIN with COUNT aggregates, ordered by the selected sort field.

### 3.4 GET /v1/oracle/agents/:id/metrics (Pro)

Detailed per-agent statistics.

**Response:**
```json
{
  "agent_id": "ae_7f3k9x2m",
  "wallets": {
    "total": 3,
    "by_chain": { "base": 2, "solana": 1 },
    "by_link_type": { "self_claim": 2, "lucid_passport": 1 }
  },
  "evidence": {
    "total": 5,
    "by_type": { "signed_message": 3, "gateway_correlation": 2 }
  },
  "protocols": {
    "total": 2,
    "list": ["lucid", "erc8004"]
  },
  "conflicts": {
    "active": 1,
    "resolved": 2
  },
  "first_seen": "2026-03-12T...",
  "last_active": "2026-03-12T..."
}
```

**SQL:** Aggregate queries on wallet_mappings, identity_evidence, identity_links, identity_conflicts — all filtered by agent_entity.

### 3.5 GET /v1/oracle/agents/:id/activity (Pro)

Recent identity events for this agent.

**Query params:**
- `limit` — max events (default 20, max 100)
- `offset` — pagination offset (default 0)

**Response:**
```json
{
  "agent_id": "ae_7f3k9x2m",
  "events": [
    {
      "type": "evidence_added",
      "evidence_type": "signed_message",
      "chain": "base",
      "address": "0x...",
      "timestamp": "2026-03-12T..."
    },
    {
      "type": "conflict_opened",
      "chain": "solana",
      "address": "7xK...",
      "role": "claiming",
      "conflict_id": 42,
      "timestamp": "2026-03-11T..."
    },
    {
      "type": "wallet_linked",
      "chain": "base",
      "address": "0x...",
      "link_type": "self_claim",
      "timestamp": "2026-03-10T..."
    }
  ],
  "limit": 20,
  "offset": 0
}
```

**SQL:** UNION query across identity_evidence (verified_at), identity_conflicts (created_at), wallet_mappings (created_at), ordered by timestamp DESC.

---

## 4. Protocol Endpoints

### 4.1 Protocol Registry

The existing hardcoded protocol list in v1.ts is extended with a `PROTOCOL_REGISTRY` constant that includes metadata. Dynamic agent/wallet counts come from Postgres.

```typescript
const PROTOCOL_REGISTRY: Record<string, ProtocolInfo> = {
  lucid: { name: 'Lucid', chains: ['offchain', 'base', 'solana'], status: 'active' },
  virtuals: { name: 'Virtuals Protocol', chains: ['base'], status: 'pending' },
  olas: { name: 'Olas / Autonolas', chains: ['gnosis', 'base', 'optimism'], status: 'pending' },
  erc8004: { name: 'ERC-8004 Agent Registry', chains: ['base'], status: 'active' },
}
```

### 4.2 GET /v1/oracle/protocols/:id

Protocol detail with dynamic stats.

**Response:**
```json
{
  "protocol": {
    "id": "lucid",
    "name": "Lucid",
    "chains": ["offchain", "base", "solana"],
    "status": "active",
    "stats": {
      "agent_count": 42,
      "total_wallets": 85,
      "total_evidence": 120
    }
  }
}
```

**SQL:**
```sql
SELECT COUNT(DISTINCT il.agent_entity) as agent_count
FROM identity_links il WHERE il.protocol = $1
```
Plus wallet/evidence counts via joins.

### 4.3 GET /v1/oracle/protocols/:id/metrics (Pro)

Deep protocol metrics.

**Response:**
```json
{
  "protocol_id": "lucid",
  "agents": {
    "total": 42,
    "by_link_type": { "gateway_correlation": 30, "self_claim": 12 }
  },
  "wallets": {
    "total": 85,
    "by_chain": { "base": 50, "solana": 35 }
  },
  "evidence": {
    "total": 120,
    "by_type": { "signed_message": 80, "gateway_correlation": 40 }
  },
  "recent_registrations_7d": 5,
  "active_conflicts": 2
}
```

---

## 5. New Files

### New files

```
apps/api/src/services/agent-query.ts          — AgentQueryService: all read queries
apps/api/src/routes/agents.ts                  — 5 agent endpoints
apps/api/src/routes/protocols.ts               — 2 enhanced protocol endpoints (detail + metrics)

apps/api/src/__tests__/agent-query.test.ts     — AgentQueryService unit tests (~12 tests)
apps/api/src/__tests__/agent-routes.test.ts    — Agent route integration tests (~8 tests)
apps/api/src/__tests__/protocol-routes.test.ts — Protocol route tests (~5 tests)
```

### Modified files

```
apps/api/src/server.ts                         — Wire agent + protocol routes
apps/api/src/routes/v1.ts                      — Remove hardcoded protocols (moved to protocols.ts)
```

---

## 6. What Plan 3A Does NOT Include

| Deferred Item | Target Plan |
|---------------|-------------|
| Revenue, cost/task, error rate metrics (ClickHouse) | Plan 3B |
| Redis hot cache for `/agents/:id` | Plan 3B |
| SSE streaming (`/v1/oracle/stream`) | Plan 3B |
| Webhook alerts | Plan 3B |
| SDK (`@lucidai/oracle`) | Plan 3B |
| MCP tools (oracle_agent_lookup, etc.) | Plan 3B |
| Full API key + plan-based tier enforcement | Plan 3B |
| Feed history endpoint (`/feeds/:id/history`) | Plan 3B |
| Report verification endpoint | Plan 3B |

---

## 7. Success Criteria

Plan 3A is complete when:
1. `GET /agents/:id` returns full agent profile with wallets, protocols, evidence count
2. `GET /agents/search` finds agents by wallet, protocol, ERC-8004 ID, or display name
3. `GET /agents/leaderboard` returns ranked agents with configurable sort
4. `GET /agents/:id/metrics` returns detailed per-agent statistics (Pro)
5. `GET /agents/:id/activity` returns recent identity events (Pro)
6. `GET /protocols/:id` returns protocol detail with dynamic agent/wallet counts
7. `GET /protocols/:id/metrics` returns deep protocol metrics (Pro)
8. All endpoints handle 404, 400, 403 correctly
9. ~25 new tests pass
10. Latency SLO: `/agents/:id` < 2s (99.5%) for Postgres-backed queries
