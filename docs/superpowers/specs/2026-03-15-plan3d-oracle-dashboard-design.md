# Plan 3D: Oracle Dashboard — Design Spec

## Overview

Extraction-ready Oracle dashboard inside LucidMerged, served at `oracle.lucid.foundation`. Self-contained `(oracle)/` route group with SDK-only data layer (`@lucid-fdn/oracle`), no cross-route-group imports, own navigation/chrome, reusing existing Lucid UI components.

**Primary audience:** Protocol teams & token launchers checking agent rankings, feed accuracy, and economic positioning.

**Aesthetic:** Bloomberg terminal — data-dense, professional, live feed ticker, financial-grade charts.

## Architecture

### Approach: Thin Route Group + SDK Hooks

New `(oracle)/` route group following the proven `(launchpad)/` pattern:
- Server layout → feature flag gate + metadata
- Client layout → Oracle-specific nav, stats ticker, shell
- React Query hooks wrapping `@lucid-fdn/oracle` SDK calls
- Reuses all `src/components/ui/*` Radix primitives
- Domain-specific components in `src/components/oracle/`
- SDK integration in `src/lib/oracle/`

### Import Boundary Rule

Files in `(oracle)/`, `components/oracle/`, and `lib/oracle/` may ONLY import from:
- `@lucid-fdn/oracle` (SDK)
- `src/components/ui/*` (shared Radix primitives)
- `src/lib/auth/*` (shared auth utils)
- `src/lib/cache/*` (shared cache config)
- `src/lib/features.ts` (feature flags)
- `src/contexts/*` (shared contexts — auth, profile, theme)
- External packages (recharts, lightweight-charts, etc.)

**Never import from:** `components/launchpad/*`, `components/ai-chat/*`, `lib/launchpad/*`, or any other route group's domain code.

### Extraction Path

When ready to extract to standalone app:
1. Copy `(oracle)/` → new app's `app/`
2. Copy `components/oracle/` → new app's `components/`
3. Copy `lib/oracle/` → new app's `lib/`
4. Replace root providers with minimal Oracle-specific provider tree
5. Middleware rewrite becomes Vercel rewrite to separate deployment

## File Structure

```
src/app/(oracle)/
├── layout.tsx                     # Server: feature flag gate + metadata
├── oracle-client-layout.tsx       # Client: nav, stats ticker, shell
├── page.tsx                       # Home: live feeds + global stats
├── loading.tsx                    # Home skeleton (feed cards + leaderboard shimmer)
├── feeds/
│   └── [id]/
│       ├── page.tsx               # Feed detail: chart + methodology
│       └── loading.tsx
├── agents/
│   ├── page.tsx                   # Search + leaderboard (tabbed)
│   ├── loading.tsx
│   └── [id]/
│       ├── page.tsx               # Agent profile + metrics
│       └── loading.tsx
├── protocols/
│   ├── page.tsx                   # Protocol list with health cards
│   ├── loading.tsx
│   └── [id]/
│       ├── page.tsx               # Protocol detail + metrics
│       └── loading.tsx
├── reports/
│   ├── page.tsx                   # Latest report + verification tool
│   └── loading.tsx
├── error.tsx                      # Route-group error boundary
└── not-found.tsx                  # 404 page ("Agent/Feed/Protocol not found")

src/components/oracle/
├── feed-chart.tsx                 # TradingView Lightweight Charts wrapper
├── feed-card.tsx                  # Feed summary card (value, confidence, staleness)
├── feed-methodology.tsx           # Methodology display (formula, weights)
├── agent-card.tsx                 # Agent summary (name, reputation, stats)
├── agent-metrics.tsx              # Detailed metrics (wallets by chain, evidence)
├── agent-activity.tsx             # Activity timeline
├── protocol-card.tsx              # Protocol card (chains, agent count)
├── protocol-metrics.tsx           # Protocol detailed metrics
├── stats-ticker.tsx               # Bloomberg-style scrolling stats bar
├── oracle-nav.tsx                 # Oracle-specific navigation
├── report-verifier.tsx            # Report signature verification UI
├── search-bar.tsx                 # Agent/protocol search
├── leaderboard-table.tsx          # Sortable leaderboard
├── model-usage-chart.tsx          # Recharts bar chart for model distribution
└── pro-gate.tsx                   # "Upgrade to Pro" overlay

src/lib/oracle/
├── sdk.ts                         # SDK singleton factory
├── hooks.ts                       # React Query hooks wrapping SDK calls
├── cache-keys.ts                  # Oracle-specific cache key constants
├── data-provider.tsx              # OracleContext provider (logic, not visual)
└── types.ts                       # Re-exports from @lucid-fdn/oracle
```

## Domain Routing

### Middleware Extension

Extend `src/middleware.ts` to detect `oracle.lucid.foundation`:

```typescript
// Exact host match — not hostname.includes() — to avoid accidental subdomain collisions
const ORACLE_HOSTS = new Set(['oracle.lucid.foundation', 'oracle.localhost:3000'])
if (ORACLE_HOSTS.has(hostname)) {
  const oraclePath = `/oracle${pathname === '/' ? '' : pathname}`
  return NextResponse.rewrite(new URL(oraclePath, req.url))
}
```

Additionally, add a **prefix-based** public route check so all oracle paths (including deep links like `/oracle/feeds/[id]`, `/oracle/agents/[id]`, `/oracle/protocols/[id]`) are accessible without login:

```typescript
// In the public route check (before auth redirect):
if (pathname.startsWith('/oracle')) {
  return NextResponse.next()
}
```

This is simpler and more robust than enumerating individual paths. The entire oracle route group is public by default — pro-tier gating happens at the component level via `<ProGate>`, not at the middleware level.

This ensures "public by default" works regardless of whether the user arrives via `oracle.lucid.foundation` (domain rewrite) or `localhost:3000/oracle/...` (direct path).

### Vercel Config

- Add `oracle.lucid.foundation` as custom domain on same Vercel project
- DNS: CNAME `oracle.lucid.foundation` → `cname.vercel-dns.com`
- No separate deployment — same build, shared env vars

### Local Development

- `oracle.localhost:3000` via middleware detection
- Or direct access at `localhost:3000/oracle/...` (works because oracle paths are in publicRoutes)

## Data Layer

### SDK Instance Management

SDK instances are managed exclusively through `OracleDataProvider` context. All hooks access the client via `useOracleClient()` — never by calling a factory function directly. This ensures API key changes (e.g., user signs in) propagate to all hooks.

```typescript
// src/lib/oracle/data-provider.tsx
const OracleContext = createContext<LucidOracle | null>(null);

export function OracleDataProvider({ children, apiKey }: { children: ReactNode; apiKey?: string }) {
  const oracle = useMemo(
    () => new LucidOracle(apiKey ? { apiKey } : undefined),
    [apiKey]
  );
  return <OracleContext.Provider value={oracle}>{children}</OracleContext.Provider>;
}

export function useOracleClient(): LucidOracle {
  const oracle = useContext(OracleContext);
  if (!oracle) throw new Error('useOracleClient must be used within OracleDataProvider');
  return oracle;
}
```

### Cache Keys

Defined in `src/lib/oracle/cache-keys.ts` as **builder functions** that produce parameterized `queryKey` arrays. This prevents collisions when the same hook type is used with different IDs, filters, or pagination cursors.

```typescript
// Cache key prefix for invalidation scoping
const P = 'oracle' as const;

// Builder functions — each returns a unique queryKey array
export const oracleKeys = {
  // Feeds
  feeds:              ()                              => [P, 'feeds'] as const,
  feedDetail:         (id: string)                    => [P, 'feeds', id] as const,
  feedHistory:        (id: string, period: string, interval: string) =>
                                                         [P, 'feeds', id, 'history', period, interval] as const,
  feedMethodology:    (id: string)                    => [P, 'feeds', id, 'methodology'] as const,

  // Agents
  agentSearch:        (q: string)                     => [P, 'agents', 'search', q] as const,
  agentLeaderboard:   (sort?: string, cursor?: string) =>
                                                         [P, 'agents', 'leaderboard', sort, cursor] as const,
  agentProfile:       (id: string)                    => [P, 'agents', id] as const,
  agentMetrics:       (id: string)                    => [P, 'agents', id, 'metrics'] as const,
  agentActivity:      (id: string, cursor?: string)   => [P, 'agents', id, 'activity', cursor] as const,
  modelUsage:         (period: string)                => [P, 'agents', 'model-usage', period] as const,

  // Protocols
  protocols:          ()                              => [P, 'protocols'] as const,
  protocolDetail:     (id: string)                    => [P, 'protocols', id] as const,
  protocolMetrics:    (id: string)                    => [P, 'protocols', id, 'metrics'] as const,

  // Reports
  latestReport:       ()                              => [P, 'reports', 'latest'] as const,
} as const;
```

Hooks use these builders for both `cacheKey` (string prefix for `useQueryWithCache`) and `queryKey` (full parameterized array for React Query). Example: `useAgentProfile('abc')` → queryKey `['oracle', 'agents', 'abc']`. No two different agents can share a cache entry.

### React Query Hooks

Every SDK method wrapped with `useQueryWithCache` (existing LucidMerged pattern):

| Hook | SDK Call | Stale Time | Tier |
|------|----------|-----------|------|
| `useFeeds()` | `feeds.list()` | 30s | Free |
| `useFeedDetail(id)` | `feeds.get({ id })` | 30s | Free |
| `useFeedHistory(id, period, interval)` | `feeds.history(...)` | 60s | Free/Pro |
| `useFeedMethodology(id)` | `feeds.methodology({ id })` | 300s | Free |
| `useAgentSearch(q)` | `agents.search({ q })` | 30s | Free |
| `useAgentLeaderboard(sort)` | `agents.leaderboard(...)` | 30s | Free |
| `useAgentProfile(id)` | `agents.get({ id })` | 60s | Free |
| `useAgentMetrics(id)` | `agents.metrics({ id })` | 120s | Pro |
| `useAgentActivity(id)` | `agents.activity({ id })` | 120s | Pro |
| `useModelUsage(period)` | `agents.modelUsage(...)` | 120s | Pro |
| `useProtocols()` | `protocols.list()` | 120s | Free |
| `useProtocolDetail(id)` | `protocols.get({ id })` | 120s | Free |
| `useProtocolMetrics(id)` | `protocols.metrics({ id })` | 120s | Pro |
| `useLatestReport()` | `reports.latest()` | 30s | Free |

### Pro Hook Gating

**Pro-tier hooks must NOT fire unless the user has an API key.** The `OracleDataProvider` exposes a `useOracleApiKey()` hook that returns the current API key (or `undefined` for anonymous users). All Pro hooks set `enabled: !!apiKey` so they remain idle until the user authenticates. This prevents unconditional 403 requests from making the network layer noisy while the UI shows `<ProGate>` overlays.

```typescript
// In data-provider.tsx — alongside OracleContext
const ApiKeyContext = createContext<string | undefined>(undefined)
export function useOracleApiKey() { return useContext(ApiKeyContext) }

// In each Pro hook:
export function useAgentMetrics(id: string) {
  const apiKey = useOracleApiKey()
  // ...
  return useQueryWithCache({ ..., enabled: !!id && !!apiKey })
}
```

Pages that contain Pro sections (agent detail, protocol detail, agents model-usage tab) call the Pro hook unconditionally in the component body — React Query's `enabled: false` ensures zero network requests are made. The `<ProGate>` overlay renders the blurred placeholder. When the user authenticates, `apiKey` becomes truthy, `enabled` flips to `true`, and the hook fires — no remount needed.

### SSE-Ready Architecture

Phase 1 (now): Polling via React Query `refetchInterval` on live-data hooks (feeds, leaderboard, latest report — 30s interval).
Phase 2 (Plan 3E): Add SSE EventSource in `OracleDataProvider` that pushes updates into query cache via `queryClient.setQueryData()`. Components unchanged — only the provider gains a `connectionMode: 'sse'` branch.

## Pages

### Home (`/` on oracle domain)

1. **Stats ticker** (fixed below nav): Scrolling marquee with AAI, APRI, AEGDP values + 24h deltas. Green pulsing "LIVE" dot. 30s auto-refresh.
2. **Feed hero**: Three large feed cards — current value (large type), confidence bar, 24h sparkline (TradingView mini), staleness dot (green/yellow/red), link to detail.
3. **Global stats row**: 4 metric boxes — Total Agents (from leaderboard `pagination.total`, not slice length), Total Protocols, Active Feeds, Last Report timestamp (from `report.timestamp` or `report.report_timestamp`, NOT `new Date()`).
4. **Leaderboard preview**: Top 5 agents table (rank, name, wallet count, protocol count, reputation). "View Full Leaderboard →" link.
5. **Protocol grid**: Cards per protocol with chain badges, agent count, status indicator.

### Feed Detail (`/feeds/[id]`)

- **TradingView chart** (Lightweight Charts): Full-width, period selector (1d/7d/30d/90d), interval selector. 30d/90d pro-gated for free users.
- **Current value panel**: Large value, confidence %, completeness, freshness, signer (truncated), signature verification badge.
- **Methodology section**: Expandable accordion — formula, weights, anchors, confidence weights from `feeds.methodology()`.

### Agents (`/agents`)

Tabbed layout: **Search** | **Leaderboard** | **Model Usage**

- **Search**: Debounced search bar → agent cards (name, ERC-8004 ID, created date). Cursor pagination.
- **Leaderboard**: Sortable table (wallet_count, protocol_count, evidence_count, newest). Cursor pagination. Row links to detail.
- **Model Usage** (pro-gated): Recharts horizontal bar chart, period selector (1d/7d/30d).

### Agent Detail (`/agents/[id]`)

- **Profile header**: Display name, ERC-8004 ID badge, reputation gauge, timestamps.
- **Stats row**: Wallet count, protocol count, evidence count.
- **Wallets table**: Chain, address (truncated + copy), link type, confidence. Grouped by chain.
- **Protocols section**: Cards per linked protocol with link type and confidence.
- **Metrics** (pro-gated): Wallets by chain (Recharts pie), evidence by type (bar), conflicts (active/resolved).
- **Activity feed** (pro-gated): Timeline — evidence_added, conflict_opened, wallet_linked with detail expansion.

### Protocols (`/protocols`)

Protocol cards grid: name, chain badges, status indicator, agent count, wallet count. Click → detail.

### Protocol Detail (`/protocols/[id]`)

- **Header**: Name, chain badges, status.
- **Stats**: Agent count, wallet count.
- **Metrics** (pro-gated): Agents by link type, wallets by chain, evidence by type, recent registrations (7d), active conflicts.

### Reports (`/reports`)

- **Latest report**: All 3 feed values with signatures, timestamp, signer set ID.
- **Verification tool**: User pastes a raw JSON report envelope (snake_case wire format) into a textarea. The UI:
  1. Parses the JSON with `try/catch` — shows inline validation error with expected shape hint on malformed input
  2. Maps snake_case fields to the SDK's camelCase request type (`feed_id` → `feedId`, `report_timestamp` → `reportTimestamp`, etc.)
  3. Calls `reports.verify({ ...mappedReport })`
  4. Displays pass/fail badges for signature check, payload integrity, and publication status with clickable Solana/Base TX links

  **Boundary note:** The snake_case → camelCase mapping is the one place where the dashboard has format-aware logic rather than pure SDK pass-through. This mapping should be a single utility function in `lib/oracle/` (e.g., `mapWireReportToSdk()`) so it can be tested independently and updated if the wire format or SDK type shape changes. The verifier component itself should only call the mapper and the SDK — no inline field remapping.

## Navigation & Chrome

**Oracle nav bar** — distinct from LucidMerged main nav, using shared UI components:
- **Logo**: "LUCID ORACLE" text mark with pulsing blue dot
- **Nav items**: Home, Feeds, Agents, Protocols, Reports
- **Right side**: API key indicator (connected/anonymous), theme toggle, "Get API Key" CTA
- **Mobile**: Hamburger → slide-down menu (launchpad pattern)
- **Glass morphism**: `backdrop-blur-xl bg-ink-900/80 border-b border-white/5`

**Stats ticker** — fixed below nav, same mechanical pattern as launchpad's StatsTicker but showing AAI, APRI, AEGDP values with 24h deltas.

## Authentication

- **Public by default**: All free-tier pages render fully without login.
- **Pro unlock flow**: ProGate overlay → two options:
  1. "Sign in" → Privy auth (existing) → API key from `gateway_tenants` record (preferred — HttpOnly session-backed)
  2. "Enter API key manually" → settings panel, key stored in localStorage. **Conscious tradeoff:** localStorage is readable by any JS on the page and is not as strong as an HttpOnly-backed session model. This is acceptable for a v1 convenience feature because (a) the API key grants read-only access to pro-tier data, not write access, and (b) the primary auth path is Privy sign-in. If the dashboard later handles sensitive write operations, this should be revisited.
- **Auth integration**: `useOracleClient()` checks auth context for API key (Privy-derived first, localStorage fallback second), falls back to anonymous SDK instance.
- **No new auth system** — reuses existing Privy + Supabase.

## Charting

- **TradingView Lightweight Charts**: Feed history (financial-grade line/area charts, period selectors). Bloomberg aesthetic.
- **Recharts**: Agent metrics (pie charts, bar charts), model usage distribution. Simpler data viz.

## Design System

Reuses existing Lucid design tokens:
- **Colors**: Primary `#0B84F3` (Lucid blue), secondary `#8B5CF6` (purple), accent `#06b6d4` (cyan)
- **Typography**: Inter font family
- **Spacing**: 8pt grid
- **Shadows**: Apple-style (`sm` through `2xl`)
- **Animations**: Apple easing `cubic-bezier(0.2, 0.8, 0.2, 1)`, spring transitions via motion/react
- **Components**: Full reuse of `src/components/ui/*` (card, table, badge, button, tabs, dialog, etc.)

## Dependencies (New)

| Package | Purpose | Status |
|---------|---------|--------|
| `@lucid-fdn/oracle` | Oracle SDK — all data fetching | **New install** |
| `lightweight-charts` | TradingView charts for feed history | Already in LucidMerged (^4.2.2) |
| `recharts` | Simple charts for metrics (pie, bar, area) | **New install** |

Other dependencies already in LucidMerged: React Query (^5.90.2), Radix UI, motion (^12.23.24), next-themes, Privy, lucide-react.

## Feature Flag

```typescript
// In src/lib/features.ts
oracleDashboard: flag('oracleDashboard', false),
```

Server layout gates on `FEATURES.oracleDashboard` — redirects to `/` when disabled.

## API Endpoints Consumed

15 endpoints from the Oracle API via `@lucid-fdn/oracle` SDK:

| Resource | Method | Endpoint | Dashboard Usage |
|----------|--------|----------|-----------------|
| feeds | list | GET /v1/oracle/feeds | Home hero, stats ticker |
| feeds | get | GET /v1/oracle/feeds/:id | Feed detail header |
| feeds | methodology | GET /v1/oracle/feeds/:id/methodology | Feed detail accordion |
| feeds | history | GET /v1/oracle/feeds/:id/history | Feed detail chart, home sparklines |
| agents | search | GET /v1/oracle/agents/search | Agents search tab |
| agents | leaderboard | GET /v1/oracle/agents/leaderboard | Agents leaderboard tab, home preview |
| agents | get | GET /v1/oracle/agents/:id | Agent detail profile |
| agents | metrics | GET /v1/oracle/agents/:id/metrics | Agent detail metrics (pro) |
| agents | activity | GET /v1/oracle/agents/:id/activity | Agent detail activity (pro) |
| agents | modelUsage | GET /v1/oracle/agents/model-usage | Agents model usage tab (pro) |
| protocols | list | GET /v1/oracle/protocols | Home grid, protocols page |
| protocols | get | GET /v1/oracle/protocols/:id | Protocol detail |
| protocols | metrics | GET /v1/oracle/protocols/:id/metrics | Protocol metrics (pro) |
| reports | latest | GET /v1/oracle/reports/latest | Reports page, home stats |
| reports | verify | POST /v1/oracle/reports/verify | Reports verification tool |

## Error Handling

- **Route-group `error.tsx`**: Catches unhandled errors. Shows "Something went wrong" with "Try Again" button and "Go to Home" link (matching launchpad pattern).
- **`not-found.tsx`**: Domain-specific 404 — "Agent not found", "Feed not found", etc. with search link.
- **SDK 404 errors**: Dynamic route pages (`[id]`) catch SDK 404 errors in the hook and render an inline "not found" state rather than throwing to the error boundary.
- **SDK 403 errors**: Pro-gated hooks catch 403 and render the `<ProGate>` overlay instead of an error state.
- **SDK 429 errors**: Rate limit errors show a toast via Sonner with retry-after countdown.
- **Network failures**: React Query's built-in retry (3 attempts, 1s delay) handles transient failures. After exhaustion, inline error state with "Retry" button.
- **Retry suppression for deterministic errors**: All oracle hooks configure React Query's `retry` option to skip retries on 400, 403, and 404 status codes. These are deterministic — retrying will not change the outcome and would make the UX feel sluggish. Only 5xx and network errors should retry.

```typescript
// Shared retry config for all oracle hooks
const oracleRetry = (failureCount: number, error: unknown) => {
  const status = (error as any)?.statusCode ?? (error as any)?.status;
  if (status && status >= 400 && status < 500) return false; // no retry on 4xx
  return failureCount < 3;
};
```
- **Loading states**: Every route has `loading.tsx` with skeleton shimmer. TradingView chart shows a pulsing placeholder rectangle while data loads. Leaderboard table shows shimmer rows.

## Conscious v1 Tradeoffs

**Client-rendered by design, not by accident.** The v1 dashboard is heavily `'use client'` — all pages fetch data via React Query hooks in the browser, with no server-side rendering of API data. This is a deliberate tradeoff for speed of implementation:

- **What we give up:** SSR, SEO indexing of feed/agent data, faster first contentful paint (server-rendered HTML).
- **What we gain:** Simpler architecture (one data-fetching pattern everywhere), real-time polling via `refetchInterval`, instant client-side navigation between pages, and a clean SSE upgrade path (Plan 3E replaces polling in the provider, not in every page).
- **Why it's acceptable for v1:** The primary audience (protocol teams, token launchers) reaches the dashboard via direct links or bookmarks, not search engines. The data changes every 30 seconds, so SSR content would be stale by the time it's crawled.
- **Path to v2:** When SEO matters (public agent profiles, feed pages as canonical URLs), introduce RSC data-fetching on key pages (feed detail, agent detail) using the SDK's server-side methods. The SDK already works in Node.js — no refactoring needed, just moving the fetch call from a hook to a server component and passing data as props. The route group structure supports this without changes.

## Non-Goals

- No admin/conflict resolution UI (stays in internal tooling)
- No agent registration flow (separate identity API)
- No wallet connection for on-chain verification (future)
- No custom theming or white-labeling
- No SSE streaming (deferred to Plan 3E — dashboard is SSE-ready)
