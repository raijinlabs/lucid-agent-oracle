# Plan 3E: SSE Streaming & Webhook Alerts — Design Spec

## Goal

Add real-time event delivery to the Oracle API. SSE streams live feed updates, agent events, and reports to connected clients. Webhook alerts push threshold-triggered notifications to external endpoints with durable, at-least-once delivery.

## Architecture

```
Redpanda consumer (API server)
  → EventBus.emit({ channel, payload, sse, webhook })
       ├── Redis PUBLISH oracle:events:{channel}  (SSE fanout)
       └── Redis XADD oracle:webhooks             (webhook queue)

SSE endpoint (GET /v1/oracle/stream)
  ← Redis SUBSCRIBE oracle:events:{channels}
  → multiplexed SSE frames to client

Webhook worker (apps/webhook-worker/)
  ← Redis XREADGROUP oracle:webhooks
  → signed HTTP POST to subscriber URLs
  → retry with exponential backoff
  → delivery log in Postgres
```

**Key decisions:**
- **Channel = logical event stream type**, not a feed ID or TCP connection
- **Hybrid fanout:** Redis Pub/Sub for ephemeral SSE, Redis Streams for durable webhooks
- **Separate webhook worker process** (`apps/webhook-worker/`) — delivery infra is a different workload from API serving and feed computation
- **No SSE replay in v1** — on reconnect, clients refresh state via REST. Event IDs emitted for forward compatibility.

**Deviations from master spec (intentional):**
- Master spec (Section 20.3) envisions a dedicated `sse-fanout` Redpanda consumer group. Plan 3E replaces this with Redis Pub/Sub fanout via EventBus. Rationale: decouples SSE connection management from Redpanda consumer group membership, avoids partition assignment issues with ephemeral API instances. Redis Pub/Sub is simpler and lower-latency for ephemeral fanout.
- Master spec (Section 9.2) defines `POST` and `GET` for `/v1/oracle/alerts`. Plan 3E adds `DELETE /v1/oracle/alerts/:id` — necessary for subscription lifecycle management.
- Master spec (Section 9.4) shows `oracle.stream('aegdp', callback)` SDK API. Plan 3E uses `oracle.stream.connect({ channels, filter })` — more expressive, aligned with multi-channel multiplexed SSE.
- Master spec (Section 18.1) says "SSE streams reconnect with last-event-id." Plan 3E ignores `Last-Event-ID` in v1 — clients refresh via REST. Forward-compatible event IDs emitted for v2 replay upgrade.
- Master spec (Section 11.1) says Growth gets "Unlimited + firehose" SSE and "Unlimited + Slack/Discord" alerts. Firehose mode and Slack/Discord integrations deferred to post-v1.

---

## 1. Event Model & EventBus

### Logical Channels

| Channel | Source | SSE | Webhook | Payload |
|---------|--------|-----|---------|---------|
| `feeds` | Redpanda INDEX_UPDATES via `handleIndexUpdate()` | yes | yes (threshold alerts) | `{ feedId, value, confidence, freshness, revision, ts }` |
| `agent_events` | Identity resolver pipeline, activity ingestion | yes | yes (reputation alerts) | `{ agentId, eventType, delta, ts }` |
| `reports` | Publication plane (new report published) | yes | yes (new report alert) | `{ reportId, feedIds, attestation, ts }` |

### EventBus Interface

```typescript
type Channel = 'feeds' | 'agent_events' | 'reports'

interface EmitOptions {
  channel: Channel
  payload: Record<string, unknown>
  sse: boolean      // → Redis PUBLISH
  webhook: boolean  // → Redis XADD
}

class EventBus {
  constructor(redis: RedisClient)
  emit(opts: EmitOptions): Promise<void>
}
```

- Each event gets a monotonic `id`: `{timestamp}-{seq}` for forward-compatible `Last-Event-ID`. Sequence generated via Redis INCR on `oracle:event_seq` to avoid conflicts across API instances.
- Bus normalizes payload shape, attaches `id` and `channel` metadata, then fans out
- Bus owns no state — stateless adapter over Redis Pub/Sub + Streams
- Not every event goes to both surfaces; the `sse`/`webhook` flags are explicit per emission

**Redis key patterns:**

| Purpose | Key | Type |
|---------|-----|------|
| SSE fanout | `oracle:events:feeds` | Pub/Sub channel |
| SSE fanout | `oracle:events:agent_events` | Pub/Sub channel |
| SSE fanout | `oracle:events:reports` | Pub/Sub channel |
| Webhook queue | `oracle:webhooks` | Stream (single, channel in payload) |

Single webhook stream because the webhook worker processes all alert types. Channel filtering happens at subscription match time.

**Location:** `apps/api/src/services/event-bus.ts`

---

## 2. SSE Endpoint

### Route

`GET /v1/oracle/stream` — Pro tier required.

### Query Parameters

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `channels` | string | yes | Comma-separated: `feeds,agent_events,reports` (1-3 values) |
| `filter` | JSON string | no | Narrows within channels: `{"feeds":["aegdp"],"agent_events":["agent_123"]}` |

### Connection Lifecycle

```
Client opens EventSource(/v1/oracle/stream?channels=feeds,reports)
  → Auth check (requireTier('pro'))
  → Validate channels param
  → Subscribe to Redis Pub/Sub: oracle:events:feeds, oracle:events:reports
  → Send: ": connected\n\n"
  → Send: "retry: 5000\n\n"
  → On Pub/Sub message:
      - Deserialize event
      - Apply client filters (if any)
      - Format as SSE frame
      - Write to response stream
  → Heartbeat every 15s: ": heartbeat\n\n"
  → On client disconnect: unsubscribe, cleanup
```

### SSE Frame Format

```
id: 1710547200000-1
event: feeds
data: {"feedId":"aegdp","value":142.7,"confidence":0.94,"freshness":12,"revision":8847,"ts":"2026-03-16T12:00:00Z"}

```

### Tiering

| Plan | Max channels/connection | Max concurrent connections/tenant |
|------|------------------------|----------------------------------|
| Pro | 3 | 3 |
| Growth | unlimited | unlimited |

Connection count tracked in-memory per API instance for v1. Redis SET for multi-instance coordination deferred.

### Error Handling

- Invalid channel name or malformed `filter` JSON → 400 Problem Details (before stream starts)
- Filter keys that don't match subscribed channels → 400 Problem Details (before stream starts)
- Auth failure → 401/403 Problem Details (before stream starts)
- Rate limit exceeded → 429 Problem Details (before stream starts)
- Once streaming: errors sent as `event: error` SSE frame, then connection closes

### Reconnection (v1)

- Server emits `retry: 5000` on connect
- `id:` field on every event (monotonic timestamp-seq)
- On reconnect with `Last-Event-ID`: server ignores it; client refreshes state via REST
- Forward-compatible: upgrade to short-buffer replay (v2) without changing event format

**Redis Pub/Sub client note:** `node-redis` v4 requires a dedicated client for subscriptions (subscriber mode blocks regular commands). The SSE handler creates a shared subscriber client via `client.duplicate()` at startup, dispatching internally to per-connection handlers. This avoids one Redis connection per SSE client.

**Location:** `apps/api/src/routes/stream.ts`

---

## 3. Webhook Management API

### Endpoints

| Method | Path | Description | Tier |
|--------|------|-------------|------|
| `POST` | `/v1/oracle/alerts` | Create webhook subscription | Pro |
| `GET` | `/v1/oracle/alerts` | List tenant's subscriptions | Pro |
| `DELETE` | `/v1/oracle/alerts/:id` | Delete subscription | Pro |

### Create Request

```json
{
  "channel": "feeds",
  "url": "https://example.com/webhook",
  "filter": { "feedIds": ["aegdp"] },
  "conditions": {
    "field": "value",
    "operator": "gt",
    "threshold": 150
  }
}
```

- `channel` — required, one of `feeds`, `agent_events`, `reports`
- `url` — required, HTTPS only, validated on create. SSRF protection: block private/reserved IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16). DNS resolved at create time to validate. Worker does not follow redirects.
- `filter` — optional, narrows which events within the channel trigger this alert
- `conditions` — optional threshold rule; if omitted, every event on the channel fires the webhook

**Operators:** `gt`, `gte`, `lt`, `lte`, `eq`, `neq`

### Create Response

Returns the subscription object + a `secret` (shown once only). The secret is used by consumers to verify HMAC signatures.

### Subscription Limits

| Plan | Max webhooks |
|------|-------------|
| Pro | 10 |
| Growth | 100 |

### Webhook Payload (delivered to subscriber URL)

```json
{
  "id": "evt_abc123",
  "channel": "feeds",
  "timestamp": "2026-03-16T12:00:00Z",
  "data": { "feedId": "aegdp", "value": 152.3, "confidence": 0.94 }
}
```

### Signing

Delivery headers: `Content-Type: application/json`, `X-Oracle-Signature`.
Signature value: HMAC-SHA256 of raw JSON body using the subscription's `secret`.

```
expected = hmac_sha256(secret, raw_body)
valid = timing_safe_equal(expected, header_value)
```

**Schemas location:** `apps/api/src/schemas/alerts.ts`
**Route handlers:** `apps/api/src/routes/alerts.ts`

---

## 4. Webhook Worker

### Location

`apps/webhook-worker/` — separate deployable process.

### Process Flow

```
Redis Stream (oracle:webhooks)
  → XREADGROUP GROUP webhook-workers CONSUMER worker-{id} BLOCK 5000
  → For each message:
      1. Load subscription from DB (in-memory cache, 60s TTL)
      2. Check subscription still active
      3. Evaluate conditions against event payload
      4. If conditions met:
         - Sign payload with subscription secret
         - POST to webhook URL (5s timeout)
         - On 2xx: XACK, write delivery record (state: delivered)
         - On 4xx: XACK, write delivery record (state: failed, no retry)
         - On 5xx/timeout: schedule retry
      5. If conditions not met: XACK, skip
```

### Retry Policy

- 5 attempts max
- Exponential backoff: 1s, 2s, 4s, 8s, 16s
- After 5 failures: XACK, write delivery record (state: `failed`), stop

**Backoff implementation:** Redis Streams have no built-in delay. Retries use a Redis sorted set (`oracle:webhook_retries`) as a delay queue. On failure, the worker ZADDs the message with score = `now + backoff_ms`. A polling loop (1s interval) ZRANGEs for due items, moves them back to the `oracle:webhooks` stream via XADD, then ZREMs them. This keeps the main stream consumer clean and avoids in-process sleep.

### Scaling

- Consumer group `webhook-workers` — multiple instances, Redis partitions work
- `XREADGROUP` prevents double-delivery
- `XAUTOCLAIM` reclaims idle messages after 30s (crashed worker recovery)

### Graceful Shutdown

- On SIGTERM: stop reading, finish in-flight deliveries (10s grace), exit
- Unacked messages reclaimed by other workers

### Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `REDIS_URL` | required | Redis connection |
| `DATABASE_URL` | required | Postgres (subscriptions + delivery log) |
| `WEBHOOK_TIMEOUT_MS` | `5000` | HTTP POST timeout |
| `WEBHOOK_MAX_RETRIES` | `5` | Max delivery attempts |
| `WEBHOOK_CONSUMER_ID` | `worker-{hostname}` | Consumer group member ID |
| `WEBHOOK_SECRET_KEY` | required | AES-256-GCM key for decrypting subscription secrets |

### Files

```
apps/webhook-worker/
├── src/
│   ├── index.ts          — entry point, stream consumer loop
│   ├── deliver.ts        — HTTP POST + HMAC signing
│   ├── evaluate.ts       — threshold condition matching
│   └── retry.ts          — backoff scheduling + dead-letter
├── package.json
└── tsconfig.json
```

---

## 5. Database Changes

### Existing `oracle_subscriptions` schema (from 001_control_plane.sql)

```sql
CREATE TABLE oracle_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'sse')),  -- kept: distinguishes subscription type
  feed_id TEXT,              -- DEPRECATED: superseded by channel + filter_json
  threshold_json JSONB,      -- DEPRECATED: superseded by conditions_json
  webhook_url TEXT,           -- kept: webhook delivery target
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Column reconciliation:**
- `type` — kept as-is. Webhook subscriptions use `type = 'webhook'`. SSE connections are ephemeral (not stored in DB), so `type = 'sse'` is unused in v1.
- `feed_id` — deprecated. Replaced by `channel` (logical topic) + `filter_json` (narrowing within channel). Left nullable, not dropped.
- `threshold_json` — deprecated. Replaced by `conditions_json` (richer operator model). Left nullable, not dropped.
- `webhook_url` — reused as-is for the delivery target URL.

### Migration: extend `oracle_subscriptions`

```sql
ALTER TABLE oracle_subscriptions
  ADD COLUMN channel TEXT CHECK (channel IN ('feeds', 'agent_events', 'reports')),
  ADD COLUMN secret_encrypted TEXT,     -- AES-256-GCM encrypted HMAC secret (server-side WEBHOOK_SECRET_KEY)
  ADD COLUMN conditions_json JSONB,     -- { field, operator, threshold }
  ADD COLUMN filter_json JSONB,         -- { feedIds: [...] } etc.
  ADD COLUMN max_retries INT NOT NULL DEFAULT 5;

-- Backfill channel from feed_id for any existing rows
UPDATE oracle_subscriptions SET channel = 'feeds' WHERE feed_id IS NOT NULL AND channel IS NULL;
```

**Secret storage:** The webhook worker needs the plaintext secret to compute HMAC signatures on every delivery. Storing only a hash would make signing impossible. Instead, the secret is encrypted at rest using AES-256-GCM with a server-side key (`WEBHOOK_SECRET_KEY` env var). The API encrypts on create, the worker decrypts on delivery. The `secret_encrypted` column stores the ciphertext + IV + auth tag as a single base64 blob.

### Migration: create `oracle_webhook_deliveries`

```sql
CREATE TABLE oracle_webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES oracle_subscriptions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 1,
  status_code INT,
  error TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','delivered','failed')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX idx_deliveries_sub ON oracle_webhook_deliveries(subscription_id);
CREATE INDEX idx_deliveries_state ON oracle_webhook_deliveries(state) WHERE state = 'pending';
```

Each row is one delivery attempt. Multiple attempts for the same event produce multiple rows (keyed by `id` = `{event_id}:{attempt}`), providing a full audit trail.

---

## 6. Degraded Mode (Redis Down)

| Surface | Behavior |
|---------|----------|
| SSE endpoint | Returns 503 Service Unavailable (Problem Details). Cannot establish Pub/Sub subscription without Redis. |
| Webhook queue (XADD) | EventBus silently drops webhook events. Logs warning. Feed updates still flow to in-memory cache and REST API — only real-time delivery is degraded. |
| Webhook worker | Blocks on XREADGROUP reconnect loop (Redis client auto-reconnects). In-flight deliveries complete. No data loss — stream is durable, resumes on reconnect. |

Redis health is already monitored by the API server's existing readiness check.

---

## 7. Integration Points

### Files Modified

| File | Change |
|------|--------|
| `apps/api/src/server.ts` | Import EventBus; wire to Redpanda consumer handlers |
| `apps/api/src/routes/v1.ts` | Register SSE route + alert CRUD routes |
| `apps/api/src/services/redis.ts` | Add Pub/Sub subscriber helper + Stream XADD/XREAD helpers |
| `packages/core/src/index.ts` | Export shared event types (channel names, payload shapes) |

### New Files (API)

| File | Purpose |
|------|---------|
| `apps/api/src/services/event-bus.ts` | EventBus class |
| `apps/api/src/routes/stream.ts` | SSE endpoint handler |
| `apps/api/src/routes/alerts.ts` | Webhook CRUD handlers |
| `apps/api/src/schemas/alerts.ts` | TypeBox schemas for alert endpoints |
| `apps/api/src/schemas/stream.ts` | TypeBox schema for stream query params |

### New Environment Variable (API)

| Env var | Purpose |
|---------|---------|
| `WEBHOOK_SECRET_KEY` | AES-256-GCM key for encrypting webhook subscription secrets at rest |

### Unchanged

- Auth plugin — reuses existing `requireTier('pro')`
- Cache plugin — SSE/alerts don't use response caching
- Rate-limit plugin — SSE connections exempt; alert CRUD uses existing per-route limits
- Cursor pagination — alerts list returns all (max 10/100 per tier), no cursors needed

---

## 8. SDK & Downstream

### SDK (`@lucid-fdn/oracle`)

New `stream` namespace:

```typescript
const stream = oracle.stream.connect({
  channels: ['feeds', 'reports'],
  filter: { feeds: ['aegdp'] }
})
stream.on('feeds', (event) => { /* ... */ })
stream.on('error', (err) => { /* ... */ })
stream.close()
```

New `alerts` namespace:

```typescript
const alert = await oracle.alerts.create({ channel: 'feeds', url: '...', conditions: { ... } })
const list = await oracle.alerts.list()
await oracle.alerts.delete({ id: alert.id })
```

Webhook signature verification utility:

```typescript
import { verifyWebhookSignature } from '@lucid-fdn/oracle'
const valid = verifyWebhookSignature(rawBody, signature, secret)
```

### Dashboard (LucidMerged)

Not in scope for Plan 3E. The dashboard already works with polling via React Query. Swapping to SSE-driven `queryClient.setQueryData()` is a clean future upgrade because the data layer is abstracted behind hooks.

### MCP Tools (Plan 3B)

Speakeasy regeneration picks up the 3 new alert CRUD endpoints as MCP tools automatically. SSE is not exposed as an MCP tool (MCP is request/response).

---

## 9. Testing

| Test | Type | What it validates |
|------|------|-------------------|
| EventBus emits to Pub/Sub and Stream | Unit | Dual fanout with sse/webhook flags |
| EventBus respects sse:false / webhook:false | Unit | Selective routing |
| SSE endpoint requires Pro tier | Integration | Auth gate |
| SSE endpoint streams feed events | Integration | End-to-end Pub/Sub → SSE frame |
| SSE heartbeat fires every 15s | Unit | Keep-alive |
| SSE disconnection cleans up subscriptions | Integration | No leaked Pub/Sub subscribers |
| Alert CRUD: create, list, delete | Integration | Full lifecycle |
| Alert create enforces HTTPS-only URL | Unit | Validation |
| Alert create enforces per-tier limits | Integration | 10 pro / 100 growth |
| Webhook worker delivers on 2xx | Integration | Happy path |
| Webhook worker retries on 5xx | Integration | Backoff schedule |
| Webhook worker stops on 4xx | Integration | No retry on client error |
| Webhook worker dead-letters after 5 failures | Integration | Terminal state |
| Condition evaluation: gt, lt, eq, etc. | Unit | Threshold matching |
| HMAC signature generation + verification | Unit | Signing correctness |
| XAUTOCLAIM reclaims idle messages | Integration | Crashed worker recovery |

---

## 10. SLOs

| Metric | Target |
|--------|--------|
| SSE event latency (Redpanda → client) | < 10s at p99 |
| Webhook first delivery attempt | < 30s from event |
| Webhook delivery success rate | > 99% (excluding subscriber errors) |
| SSE connection uptime | > 99.5% (excluding client disconnects) |

---

## 11. Out of Scope (v1)

- SSE replay / `Last-Event-ID` buffer (upgrade path to v2)
- SSE-driven dashboard cache invalidation (dashboard stays polling for now)
- Cross-instance SSE connection counting (in-memory per instance is fine for v1)
- Webhook delivery dashboard/UI
- Firehose mode for Growth tier (channel multiplexing is sufficient) — deferred master spec feature
- Slack/Discord alert integrations — deferred master spec feature (Growth tier)
- Alert pause/resume (delete and recreate)
