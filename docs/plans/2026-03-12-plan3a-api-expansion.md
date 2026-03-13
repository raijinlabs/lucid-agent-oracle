# Plan 3A: API Expansion Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan.

**Goal:** Expose agent entities as queryable, searchable, ranked first-class resources via 7 new API endpoints.

**Architecture:** Single AgentQueryService encapsulates all Postgres read queries. Thin route files delegate to service. Tier enforcement via header check.

**Tech Stack:** TypeScript, Fastify, Postgres (pg), Vitest

---

## Task 1: AgentQueryService — getProfile

**Files:**
- Create: `apps/api/src/services/agent-query.ts`
- Test: `apps/api/src/__tests__/agent-query.test.ts`

Implement `AgentQueryService.getProfile(id)` that queries agent_entities + wallet_mappings + identity_links + evidence count. Returns null if not found.

## Task 2: AgentQueryService — search

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Test: `apps/api/src/__tests__/agent-query.test.ts`

Implement `search(params)` with dynamic WHERE clause building for wallet, chain, protocol, protocol_id, erc8004_id, q (ILIKE), with limit/offset pagination and total count.

## Task 3: AgentQueryService — leaderboard

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Test: `apps/api/src/__tests__/agent-query.test.ts`

Implement `leaderboard(params)` with LEFT JOIN aggregates, sorted by wallet_count/protocol_count/evidence_count/newest, with limit/offset and total.

## Task 4: AgentQueryService — getMetrics and getActivity

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Test: `apps/api/src/__tests__/agent-query.test.ts`

Implement `getMetrics(id)` with aggregate queries for wallet/evidence/protocol/conflict breakdowns. Implement `getActivity(id, limit, offset)` with UNION query across evidence/conflicts/mappings.

## Task 5: AgentQueryService — protocol queries

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Test: `apps/api/src/__tests__/agent-query.test.ts`

Implement `getProtocol(id)` and `getProtocolMetrics(id)` with agent counts, wallet stats, evidence breakdowns from identity_links + wallet_mappings + identity_evidence joins.

## Task 6: Agent routes

**Files:**
- Create: `apps/api/src/routes/agents.ts`
- Test: `apps/api/src/__tests__/agent-routes.test.ts`

Register 5 endpoints: GET agents/:id, agents/search, agents/leaderboard, agents/:id/metrics (Pro), agents/:id/activity (Pro). Tier check for Pro endpoints.

## Task 7: Protocol routes

**Files:**
- Create: `apps/api/src/routes/protocols.ts`
- Modify: `apps/api/src/routes/v1.ts` (remove hardcoded protocols)
- Test: `apps/api/src/__tests__/protocol-routes.test.ts`

Register 2 endpoints: GET protocols/:id, protocols/:id/metrics (Pro). Move PROTOCOL_REGISTRY constant here.

## Task 8: Wire into server.ts + full test suite

**Files:**
- Modify: `apps/api/src/server.ts`

Import and call registerAgentRoutes + registerProtocolRoutes with db client. Run full test suite, verify 0 failures.
