# Agent Universe Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a viral, Bloomberg-terminal-style agent economy dashboard with maximum data enrichment — token balances, live activity feed, network graph, multiple leaderboards, ENS resolution, Olas enrichment, NFTs, DeFi positions, gas metrics, contract analysis, comparison mode, and global economy metrics.

**Architecture:** Three-layer approach: (1) Backend data enrichment services that poll/compute and store in Supabase, (2) Oracle API endpoints that serve enriched data, (3) Next.js dashboard components that consume and visualize. Each layer is independently deployable and testable.

**Tech Stack:** Node.js/TypeScript, Fastify, Supabase (Postgres), ClickHouse, Redis Pub/Sub, SSE, Next.js 15, React Three Fiber (3D graph), Recharts (charts), SWR, Tailwind CSS, QuickNode RPC, Moralis, Helius.

---

## Subsystem Breakdown

This plan covers 5 independent subsystems that can be built in parallel:

1. **Data Enrichment Backend** (Tasks 1-6) — New enrichment services + DB tables
2. **API Endpoints** (Tasks 7-9) — New Oracle API routes for enriched data
3. **Dashboard Core** (Tasks 10-13) — Stats, leaderboards, enhanced agent profile
4. **Real-Time & Visualization** (Tasks 14-16) — Live feed, network graph, comparison
5. **Global Economy Dashboard** (Task 17) — TVL, volume, trends overview

---

## File Map

### Backend (lucid-agent-oracle)

| File | Action | Purpose |
|------|--------|---------|
| `packages/core/src/adapters/balance-enricher.ts` | Create | Token balances + native ETH per wallet |
| `packages/core/src/adapters/ens-resolver.ts` | Create | ENS/Basename resolution for owner wallets |
| `packages/core/src/adapters/olas-enricher.ts` | Create | Olas marketplace scraper (images, descriptions) |
| `packages/core/src/adapters/nft-enricher.ts` | Create | NFT holdings per wallet (Moralis) |
| `packages/core/src/adapters/gas-metrics.ts` | Create | Gas usage + activity intensity |
| `packages/core/src/adapters/contract-analyzer.ts` | Create | Contract interaction frequency analysis |
| `packages/core/src/adapters/defi-enricher.ts` | Create | DeFi positions per wallet (Moralis) |
| `packages/core/src/adapters/economy-metrics.ts` | Create | Global economy aggregates (TVL, volume, trends) |
| `packages/core/src/index.ts` | Modify | Export new enrichers |
| `apps/api/src/server.ts` | Modify | Wire new enrichers |
| `apps/api/src/routes/agents.ts` | Modify | Add enriched profile + comparison + leaderboards |
| `apps/api/src/routes/economy.ts` | Create | Global economy metrics endpoint |
| `apps/api/src/services/agent-query.ts` | Modify | Add enriched queries |
| `apps/api/src/schemas/agents.ts` | Modify | Add enriched TypeBox schemas |
| `migrations/supabase/20260320_enrichment.sql` | Create | New tables for balances, ENS, NFTs, gas, contracts |

### Dashboard (LucidMerged)

| File | Action | Purpose |
|------|--------|---------|
| `src/lib/oracle/api.ts` | Modify | Add new API functions |
| `src/app/api/oracle/agents/[id]/route.ts` | Create | Agent detail proxy |
| `src/app/api/oracle/economy/route.ts` | Create | Economy metrics proxy |
| `src/app/(cloud)/oracle/page.tsx` | Rewrite | Bloomberg-style economy dashboard |
| `src/app/(cloud)/oracle/agents/agents-client.tsx` | Modify | Multiple leaderboard tabs |
| `src/app/(cloud)/oracle/agents/[id]/page.tsx` | Rewrite | Full enriched agent profile |
| `src/app/(cloud)/oracle/agents/compare/page.tsx` | Create | Side-by-side comparison |
| `src/components/oracle/live-feed.tsx` | Create | Real-time SSE activity ticker |
| `src/components/oracle/network-graph.tsx` | Create | Force-directed agent graph (React Three Fiber) |
| `src/components/oracle/agent-chart.tsx` | Create | Activity/balance time series |
| `src/components/oracle/economy-stats.tsx` | Create | Global economy metrics bar |
| `src/components/oracle/leaderboard-tabs.tsx` | Create | Tabbed leaderboard component |
| `src/components/oracle/comparison-panel.tsx` | Create | Agent comparison view |
| `src/components/oracle/wallet-portfolio.tsx` | Create | Token balances display |
| `src/components/oracle/defi-positions.tsx` | Create | DeFi positions display |
| `src/hooks/use-oracle-stream.ts` | Create | SSE EventSource hook for real-time events |
| `src/app/(cloud)/oracle/network/page.tsx` | Create | Force-directed network graph page |

---

## Task 1: Database Migration — Enrichment Tables

**Files:**
- Create: `migrations/supabase/20260320_enrichment.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- Agent wallet token balances (snapshot, refreshed periodically)
CREATE TABLE IF NOT EXISTS oracle_wallet_balances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  token_decimals INTEGER,
  balance_raw TEXT NOT NULL,
  balance_usd NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, wallet_address, token_address)
);
CREATE INDEX IF NOT EXISTS idx_wallet_balances_entity ON oracle_wallet_balances (agent_entity);

-- Gas data on existing transactions table (needed for gas metrics enricher)
ALTER TABLE oracle_wallet_transactions
  ADD COLUMN IF NOT EXISTS gas_used NUMERIC,
  ADD COLUMN IF NOT EXISTS gas_price NUMERIC;

-- DeFi positions (LP, staking, lending on Base)
CREATE TABLE IF NOT EXISTS oracle_defi_positions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  protocol_name TEXT NOT NULL,
  position_type TEXT NOT NULL CHECK (position_type IN ('lp', 'staking', 'lending', 'borrowing', 'farming')),
  token_address TEXT,
  token_symbol TEXT,
  balance_raw TEXT,
  balance_usd NUMERIC,
  apy NUMERIC,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, wallet_address, protocol_name, position_type, token_address)
);
CREATE INDEX IF NOT EXISTS idx_defi_positions_entity ON oracle_defi_positions (agent_entity);

-- ENS/Basename resolved names
CREATE TABLE IF NOT EXISTS oracle_name_resolution (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  resolved_name TEXT,
  avatar_url TEXT,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address)
);

-- Agent images and enriched descriptions (from Olas, URI, etc.)
ALTER TABLE oracle_agent_entities
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT;

-- NFT holdings
CREATE TABLE IF NOT EXISTS oracle_nft_holdings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  token_id TEXT NOT NULL,
  name TEXT,
  image_url TEXT,
  collection_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, wallet_address, contract_address, token_id)
);
CREATE INDEX IF NOT EXISTS idx_nft_entity ON oracle_nft_holdings (agent_entity);

-- Gas usage metrics (per agent, aggregated)
CREATE TABLE IF NOT EXISTS oracle_gas_metrics (
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('24h', '7d', '30d')),
  tx_count INTEGER NOT NULL DEFAULT 0,
  gas_used_total NUMERIC NOT NULL DEFAULT 0,
  gas_cost_eth NUMERIC NOT NULL DEFAULT 0,
  gas_cost_usd NUMERIC,
  first_tx_at TIMESTAMPTZ,
  last_tx_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_entity, chain, period)
);

-- Contract interactions (which contracts each agent calls most)
CREATE TABLE IF NOT EXISTS oracle_contract_interactions (
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  contract_name TEXT,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  last_interaction_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_entity, chain, contract_address)
);

-- Global economy snapshots (hourly)
CREATE TABLE IF NOT EXISTS oracle_economy_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_agents INTEGER NOT NULL,
  active_agents_24h INTEGER NOT NULL DEFAULT 0,
  total_wallets INTEGER NOT NULL,
  total_tvl_usd NUMERIC NOT NULL DEFAULT 0,
  tx_volume_24h_usd NUMERIC NOT NULL DEFAULT 0,
  tx_count_24h INTEGER NOT NULL DEFAULT 0,
  new_agents_7d INTEGER NOT NULL DEFAULT 0,
  avg_reputation_score NUMERIC,
  top_tokens_json JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_economy_snapshots_at ON oracle_economy_snapshots (snapshot_at DESC);
```

- [ ] **Step 2: Apply migration**

Run: `cd /c/lucid-plateform-core && npx supabase db query --linked -f /c/lucid-agent-oracle/migrations/supabase/20260320_enrichment.sql`

- [ ] **Step 3: Commit**

```bash
git add migrations/supabase/20260320_enrichment.sql
git commit -m "feat: enrichment tables — balances, ENS, NFTs, gas, contracts, economy"
```

---

## Task 2: Token Balance Enricher

**Files:**
- Create: `packages/core/src/adapters/balance-enricher.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write balance enricher**

Polls all active agent wallets and fetches ERC-20 + native ETH balances via Moralis `getWalletTokenBalances` (free tier: 40k calls/day). Stores in `oracle_wallet_balances`. Runs every 5 minutes. Advisory-locked.

Key design:
- Batch wallets (20 per cycle to stay within rate limits)
- Moralis returns all ERC-20 balances + native in one call per wallet
- USD values from token registry (stablecoin exact, others from last_known_usd_price)
- Upsert on `(chain, wallet_address, token_address)`

- [ ] **Step 2: Export from index.ts**
- [ ] **Step 3: Wire into server.ts (runs if MORALIS_API_KEY set)**
- [ ] **Step 4: Test balance enricher**
- [ ] **Step 5: Commit**

---

## Task 3: ENS / Basename Resolver

**Files:**
- Create: `packages/core/src/adapters/ens-resolver.ts`

- [ ] **Step 1: Write ENS resolver**

Uses QuickNode RPC to resolve ENS names (mainnet) and Basenames (Base) for owner wallet addresses. Calls `addr.reverse` on the ENS registry. Stores in `oracle_name_resolution`. Runs every 10 minutes, 50 addresses per cycle.

Key design:
- Base: Basenames registry at `0x...` (L2 reverse resolution)
- Ethereum: ENS reverse resolution via `addr.reverse` node
- Falls back gracefully if no name set
- Also fetches avatar URL if available (EIP-3668)

- [ ] **Step 2: Export and wire**
- [ ] **Step 3: Commit**

---

## Task 4: Olas Marketplace Enricher

**Files:**
- Create: `packages/core/src/adapters/olas-enricher.ts`

- [ ] **Step 1: Write Olas enricher**

Fetches agent metadata from Olas marketplace URLs (`marketplace.olas.network/erc8004/base/ai-agents/{serviceId}`). The URI resolver already parsed the registration JSON, but Olas marketplace pages have richer data (images, category, detailed description). Scrapes public HTML or API if available.

Key design:
- Only processes agents with `agent_uri LIKE '%olas.network%'`
- Extracts: image_url, full description, category
- Updates `oracle_agent_entities.image_url`, `.description`, `.category`
- Rate limited: 5 fetches per cycle, 500ms between requests
- Runs every 15 minutes

- [ ] **Step 2: Export and wire**
- [ ] **Step 3: Commit**

---

## Task 5: NFT Holdings + Gas Metrics + Contract Analysis

**Files:**
- Create: `packages/core/src/adapters/nft-enricher.ts`
- Create: `packages/core/src/adapters/gas-metrics.ts`
- Create: `packages/core/src/adapters/contract-analyzer.ts`

- [ ] **Step 1: Write NFT enricher**

Uses Moralis `getWalletNFTs` to fetch NFT holdings per agent wallet. Stores in `oracle_nft_holdings`. Runs every 30 minutes, 10 wallets per cycle.

- [ ] **Step 2: Write gas metrics computer**

Queries `oracle_wallet_transactions` to compute per-agent gas usage aggregates for 24h/7d/30d periods. Stores in `oracle_gas_metrics`. Runs every 15 minutes.

Note: Current `oracle_wallet_transactions` doesn't store gas data — will need to add `gas_used` and `gas_price` columns, or compute from RPC `eth_getTransactionReceipt`.

- [ ] **Step 3: Write contract analyzer**

Queries `oracle_wallet_transactions` grouped by `counterparty` (the contract address the agent interacted with). Counts interactions per contract, resolves contract names via Basescan/Moralis. Stores in `oracle_contract_interactions`. Runs every 15 minutes.

- [ ] **Step 4: Export all three and wire**
- [ ] **Step 5: Commit**

---

## Task 5b: DeFi Position Enricher

**Files:**
- Create: `packages/core/src/adapters/defi-enricher.ts`

- [ ] **Step 1: Write DeFi enricher**

Uses Moralis `getDefiPositionsByWallet` (or `getDefiSummary`) to fetch LP, staking, lending, farming positions per agent wallet on Base. Stores in `oracle_defi_positions`. Runs every 30 minutes, 10 wallets per cycle.

Key design:
- Only fetches for wallets on Base (chain='base')
- Captures: protocol name, position type, token, balance, USD value, APY
- Upsert on `(chain, wallet_address, protocol_name, position_type, token_address)`
- Popular Base protocols: Aerodrome, Aave, Compound, Moonwell, Extra Finance

- [ ] **Step 2: Export and wire (runs if MORALIS_API_KEY set)**
- [ ] **Step 3: Commit**

---

## Task 6: Global Economy Metrics Computer

**Files:**
- Create: `packages/core/src/adapters/economy-metrics.ts`

- [ ] **Step 1: Write economy metrics**

Computes hourly economy snapshots:
- `total_agents`: COUNT from oracle_agent_entities
- `active_agents_24h`: agents with transactions in last 24h
- `total_wallets`: active wallet mappings
- `total_tvl_usd`: SUM of oracle_wallet_balances.balance_usd
- `tx_volume_24h_usd`: SUM of oracle_wallet_transactions.amount_usd in last 24h
- `tx_count_24h`: COUNT of transactions in last 24h
- `new_agents_7d`: agents registered in last 7 days
- `avg_reputation_score`: AVG of reputation_json->'avg_value' where <= 100
- `top_tokens_json`: Top 10 tokens by total balance across all agents

Stores in `oracle_economy_snapshots`. Runs every hour. Advisory-locked.

- [ ] **Step 2: Export and wire**
- [ ] **Step 3: Commit**

---

## Task 7: API — Enriched Agent Profile Endpoint

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/schemas/agents.ts`

- [ ] **Step 1: Add getEnrichedProfile method to AgentQueryService**

Returns everything we have about an agent:
```typescript
{
  ...existingProfile,
  balances: { total_usd, tokens: [{ symbol, balance, usd_value }] },
  nfts: [{ name, collection, image_url }],
  gas_metrics: { tx_count_24h, gas_cost_usd_7d },
  top_contracts: [{ address, name, count }],
  owner_name: string | null, // ENS/Basename
  image_url: string | null,
  description: string | null,
  category: string | null,
  activity_score: number, // computed from tx frequency
}
```

- [ ] **Step 2: Update TypeBox schema**
- [ ] **Step 3: Update route handler to use enriched profile**
- [ ] **Step 4: Test**
- [ ] **Step 5: Commit**

---

## Task 8: API — Economy Metrics Endpoint

**Files:**
- Create: `apps/api/src/routes/economy.ts`

- [ ] **Step 1: Write economy routes**

```
GET /v1/oracle/economy/current — Latest economy snapshot
GET /v1/oracle/economy/history?period=7d — Time series of snapshots
```

- [ ] **Step 2: Register route in server.ts**
- [ ] **Step 3: Test**
- [ ] **Step 4: Commit**

---

## Task 9: API — Agent Comparison + Multiple Leaderboards

**Files:**
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/services/agent-query.ts`

- [ ] **Step 1: Add comparison endpoint**

```
GET /v1/oracle/agents/compare?ids=ae_xxx,ae_yyy,ae_zzz
```
Returns enriched profiles for up to 4 agents side-by-side.

- [ ] **Step 2: Add leaderboard variants**

Existing leaderboard endpoint gets new `category` param:
```
GET /v1/oracle/agents/leaderboard?sort=reputation_score  (Top Reputation)
GET /v1/oracle/agents/leaderboard?sort=tx_count          (Most Active)
GET /v1/oracle/agents/leaderboard?sort=tvl               (Richest)
GET /v1/oracle/agents/leaderboard?sort=connections        (Most Connected)
GET /v1/oracle/agents/leaderboard?sort=rising             (Rising Stars — 7d growth)
```

- [ ] **Step 3: Test**
- [ ] **Step 4: Commit**

---

## Task 10: Dashboard — Global Economy Overview Page

**Files:**
- Rewrite: `src/app/(cloud)/oracle/page.tsx`
- Create: `src/components/oracle/economy-stats.tsx`
- Create: `src/app/api/oracle/economy/route.ts`

- [ ] **Step 1: Create economy stats proxy route**
- [ ] **Step 2: Create economy-stats component**

Bloomberg-terminal style:
- Top bar: TVL | 24h Volume | Agents | Active (24h) | New (7d) | Avg Reputation
- Feed cards below (existing)
- Live activity feed on the right (Task 14)

- [ ] **Step 3: Rewrite oracle overview page**
- [ ] **Step 4: Commit**

---

## Task 11: Dashboard — Multiple Leaderboard Tabs

**Files:**
- Create: `src/components/oracle/leaderboard-tabs.tsx`
- Modify: `src/app/(cloud)/oracle/agents/agents-client.tsx`

- [ ] **Step 1: Create LeaderboardTabs component**

Tabs: Smart Ranking | Top Reputation | Most Active | Richest | Most Connected | Rising Stars

Each tab triggers a different `sort` param. Uses existing `InfiniteList` with `key={tab}` for remount.

- [ ] **Step 2: Integrate into agents page**
- [ ] **Step 3: Commit**

---

## Task 12: Dashboard — Enriched Agent Profile Page

**Files:**
- Rewrite: `src/app/(cloud)/oracle/agents/[id]/page.tsx`
- Create: `src/components/oracle/wallet-portfolio.tsx`
- Create: `src/components/oracle/agent-chart.tsx`
- Create: `src/app/api/oracle/agents/[id]/route.ts`

- [ ] **Step 1: Create agent detail proxy route**
- [ ] **Step 2: Create wallet-portfolio component**

Token balance table + pie chart of holdings. Shows:
- Token symbol, balance, USD value, % of portfolio
- Native ETH balance
- Total portfolio value

- [ ] **Step 3: Create agent-chart component**

Activity chart (7d/30d) using Recharts:
- X: date, Y: transaction count
- Overlay: cumulative USD volume

- [ ] **Step 4: Rewrite agent detail page**

Full Bloomberg layout:
- Header: image, name, description, status, category, ecosystem tag
- Metrics row: Portfolio Value | Reputation | Transactions | Gas Cost | Services
- Two columns:
  - Left: Wallet Portfolio, DeFi Positions, Activity Chart, Top Contracts
  - Right: Services, Protocol Links, NFT Holdings, On-Chain Metadata
- Owner: ENS/Basename resolved name

- [ ] **Step 5: Commit**

---

## Task 13: Dashboard — Agent Comparison Mode

**Files:**
- Create: `src/app/(cloud)/oracle/agents/compare/page.tsx`
- Create: `src/components/oracle/comparison-panel.tsx`

- [ ] **Step 1: Create comparison page**

URL: `/oracle/agents/compare?ids=ae_xxx,ae_yyy`

Side-by-side view of 2-4 agents:
- Reputation gauges
- Portfolio value bars
- Activity sparklines
- Service count comparison
- "Better at" summary

- [ ] **Step 2: Add "Compare" button to agent rows**
- [ ] **Step 3: Commit**

---

## Task 14: Dashboard — Live Activity Feed (SSE)

**Files:**
- Create: `src/components/oracle/live-feed.tsx`
- Create: `src/hooks/use-oracle-stream.ts`

- [ ] **Step 1: Create SSE hook**

```typescript
function useOracleStream(channels: string[]) {
  // 1. Fetch stream token from /api/oracle/stream/token
  // 2. Connect EventSource to Oracle API /v1/oracle/stream?token=...&channels=...
  // 3. Parse SSE events, buffer last 50
  // 4. Return { events, isConnected, error }
}
```

- [ ] **Step 2: Create live-feed component**

Scrolling ticker showing real-time events:
```
🟢 Agent #888 received 0.5 USDC               2s ago
🔵 "Reldo" registered new service              15s ago
🟡 New agent #2194 registered on Base          1m ago
⭐ Agent #1375 reached 100% reputation         3m ago
```

Color-coded by event type. Auto-scrolls. Clickable → agent detail.

- [ ] **Step 3: Add stream token proxy route**
- [ ] **Step 4: Integrate into oracle overview page**
- [ ] **Step 5: Commit**

---

## Task 15: Dashboard — Network Graph (3D Force-Directed)

**Files:**
- Create: `src/components/oracle/network-graph.tsx`
- Create: `src/app/(cloud)/oracle/network/page.tsx`
- Create: `src/app/api/oracle/network/route.ts`

- [ ] **Step 1: Create network data API**

```
GET /api/oracle/network?limit=500
```
Returns:
```json
{
  "nodes": [{ "id": "ae_xxx", "name": "Reldo", "group": "olas", "score": 99, "wallets": 3 }],
  "links": [{ "source": "ae_xxx", "target": "ae_yyy", "value": 5 }]
}
```

Links are derived from `oracle_wallet_transactions` where both sender and receiver are agent wallets.

- [ ] **Step 2: Add Oracle API endpoint for graph data**

New endpoint: `GET /v1/oracle/agents/graph?limit=500`
- Nodes: top N agents by smart score
- Links: agent-to-agent transactions (join wallet_transactions with wallet_mappings)

- [ ] **Step 3: Create network-graph component**

Use `@react-force-graph/3d` (WebGL, handles 10k+ nodes at 60fps):
- Node size = reputation score
- Node color = ecosystem (Olas=blue, independent=zinc, etc.)
- Link thickness = transaction count between agents
- Named agents show labels
- Click node → navigate to agent detail
- Hover → tooltip with stats
- Dark background with glow effects

Fallback: 2D canvas for mobile.

- [ ] **Step 4: Create network page**
- [ ] **Step 5: Add nav link for network view**
- [ ] **Step 6: Commit**

---

## Task 16: Dashboard — Agent-to-Agent Transaction Discovery

**Files:**
- Modify: `apps/api/src/services/agent-query.ts`
- Modify: `apps/api/src/routes/agents.ts`

- [ ] **Step 1: Write agent-to-agent transaction query**

Cross-reference `oracle_wallet_transactions` with `oracle_wallet_mappings`:
```sql
SELECT
  wt.agent_entity as from_agent,
  wm2.agent_entity as to_agent,
  count(*) as tx_count,
  sum(wt.amount_usd) as total_usd
FROM oracle_wallet_transactions wt
JOIN oracle_wallet_mappings wm2 ON LOWER(wt.counterparty) = LOWER(wm2.address)
  AND wm2.chain = wt.chain AND wm2.removed_at IS NULL
WHERE wt.direction = 'outbound'
GROUP BY wt.agent_entity, wm2.agent_entity
```

This finds which agents transact with each other — the data for the network graph links.

- [ ] **Step 2: Add graph data endpoint**
- [ ] **Step 3: Test**
- [ ] **Step 4: Commit**

---

## Task 17: Dashboard — Oracle Nav Upgrade

**Files:**
- Modify: `src/components/oracle/oracle-nav.tsx`
- Modify: `src/app/(cloud)/oracle/layout.tsx`

- [ ] **Step 1: Update navigation**

Add links:
- Overview (economy dashboard)
- Agents (registry + leaderboards)
- Network (3D graph)
- Feeds (existing)

- [ ] **Step 2: Commit**

---

## Execution Order (Dependencies)

```
Phase 1 (Data — can run in parallel):
  Task 1: Migration (required first)
  Task 2: Balance enricher (needs Task 1)
  Task 3: ENS resolver (needs Task 1)
  Task 4: Olas enricher (needs Task 1)
  Task 5: NFTs + Gas + Contracts (needs Task 1)
  Task 5b: DeFi positions (needs Task 1)
  Task 6: Economy metrics (needs Task 1)
  Task 16: Agent-to-agent discovery (no enrichment dependency — uses existing tx data)

Phase 2 (API — after Phase 1):
  Task 7: Enriched profile (needs Tasks 2-5b)
  Task 8: Economy endpoint (needs Task 6)
  Task 9: Comparison + leaderboards (needs Task 7)

Phase 3 (Dashboard — after Phase 2):
  Task 10: Economy overview (needs Task 8)
  Task 11: Leaderboard tabs (needs Task 9)
  Task 12: Enriched profile page (needs Task 7)
  Task 13: Comparison mode (needs Task 9)
  Task 14: Live feed (independent — uses existing SSE)
  Task 15: Network graph (needs Task 16)
  Task 17: Nav upgrade (last)
```

## Cost Estimate

| Service | Current | After Enrichment | Delta |
|---------|---------|-----------------|-------|
| QuickNode | Free | Free (ENS + balance calls within 50M/mo) | $0 |
| Moralis | Free | Free (balances + NFTs within 40k/day) | $0 |
| Helius | Free | Free (same usage) | $0 |
| Railway | ~$33 | ~$35 (slightly more CPU for enrichers) | +$2 |
| Supabase | Free | Free (under 500MB) | $0 |
| **Total** | **~$33/mo** | **~$35/mo** | **+$2** |

All enrichers use existing free-tier APIs within rate limits. The cost increase is negligible.
