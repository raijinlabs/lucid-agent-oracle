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

- Each event gets a monotonic `id`: `{timestamp}-{seq}` for forward-compatible `Last-Event-ID`
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

- Invalid channel name → 400 Problem Details (before stream starts)
- Auth failure → 401/403 Problem Details (before stream starts)
- Rate limit exceeded → 429 Problem Details (before stream starts)
- Once streaming: errors sent as `event: error` SSE frame, then connection closes

### Reconnection (v1)

- Server emits `retry: 5000` on connect
- `id:` field on every event (monotonic timestamp-seq)
- On reconnect with `Last-Event-ID`: server ignores it; client refreshes state via REST
- Forward-compatible: upgrade to short-buffer replay (v2) without changing event format

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
- `url` — required, HTTPS only, validated on create
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

Header: `X-Oracle-Signature`
Value: HMAC-SHA256 of raw JSON body using the subscription's `secret`

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
- Retries go back into the stream with incremented attempt count
- After 5 failures: XACK, write delivery record (state: `failed`), stop

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

### Migration: extend `oracle_subscriptions`

```sql
ALTER TABLE oracle_subscriptions
  ADD COLUMN secret_hash TEXT,
  ADD COLUMN conditions_json JSONB,
  ADD COLUMN filter_json JSONB,
  ADD COLUMN max_retries INT NOT NULL DEFAULT 5;
```

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
  delivered_at TIMESTAMPTZ
);
CREATE INDEX idx_deliveries_sub ON oracle_webhook_deliveries(subscription_id);
CREATE INDEX idx_deliveries_state ON oracle_webhook_deliveries(state) WHERE state = 'pending';
```

---

## 6. Integration Points

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

### Unchanged

- Auth plugin — reuses existing `requireTier('pro')`
- Cache plugin — SSE/alerts don't use response caching
- Rate-limit plugin — SSE connections exempt; alert CRUD uses existing per-route limits
- Cursor pagination — alerts list returns all (max 10/100 per tier), no cursors needed

---

## 7. SDK & Downstream

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

## 8. Testing

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

## 9. SLOs

| Metric | Target |
|--------|--------|
| SSE event latency (Redpanda → client) | < 10s at p99 |
| Webhook first delivery attempt | < 30s from event |
| Webhook delivery success rate | > 99% (excluding subscriber errors) |
| SSE connection uptime | > 99.5% (excluding client disconnects) |

---

## 10. Out of Scope (v1)

- SSE replay / `Last-Event-ID` buffer (upgrade path to v2)
- SSE-driven dashboard cache invalidation (dashboard stays polling for now)
- Cross-instance SSE connection counting (in-memory per instance is fine for v1)
- Webhook delivery dashboard/UI
- Firehose mode for Growth tier (channel multiplexing is sufficient)
- Alert pause/resume (delete and recreate)
