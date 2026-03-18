# No-Broker Adapter Mode — Design Spec

**Date:** 2026-03-18
**Status:** Design
**Replaces:** Redpanda-based adapter pipeline (Plan 4A Sections 3-5)
**Preserves:** All adapter contracts, resolver logic, identity flow, raw event schema

## Problem

Redpanda cannot run on Railway (kernel AIO limit). The frozen Plan 4A design routes all adapter events through Redpanda topics (`raw.erc8004.events`, `raw.agent_wallets.events`, `wallet_watchlist.updated`). Without a broker, adapters have no ingestion path.

The ad-hoc fix (Ponder writing directly to final tables) was reverted because it:
- Bypassed the resolver (identity logic split across adapters)
- Broke the raw event audit trail
- Created inconsistent ingestion paths between adapters
- Lost the replay/reprocess capability

## Design Principle

> Adapters are dumb pipes. They normalize and write raw events. The resolver is the single identity writer. A staging table replaces the broker topic.

## Architecture

```
Adapters (Ponder, Helius, Gateway poller, future)
    │
    │  sink.writeRawEvent(event)
    ▼
┌─────────────────────────────────┐
│  AdapterSink interface          │
│  ├── DirectSink (Postgres)      │  ← now
│  └── BrokerSink (Kafka/Redpanda)│  ← future, swap via env var
└─────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────┐
│  oracle_raw_adapter_events      │  staging table (Postgres)
│  (source, chain, event_type,    │  or Kafka topic (future)
│   payload_json, processed_at)   │
└─────────────────────────────────┘
    │
    │  Resolver polls unprocessed rows (SKIP LOCKED)
    ▼
┌─────────────────────────────────┐
│  Identity Resolver              │  single writer for:
│  (existing logic from Plan 4A)  │  - oracle_agent_entities
│                                 │  - oracle_wallet_mappings
│                                 │  - oracle_identity_links
│                                 │  - oracle_identity_evidence
└─────────────────────────────────┘
    │
    │  On new wallet mapping:
    ▼
┌─────────────────────────────────┐
│  Watchlist Refresh              │
│  ├── DirectNotify (Redis PUBLISH)│ ← now
│  └── BrokerNotify (Kafka topic) │ ← future
└─────────────────────────────────┘
```

## 1. AdapterSink Interface

```typescript
// packages/core/src/adapters/sink.ts

export interface RawAdapterEvent {
  event_id: string
  source: string           // 'erc8004', 'helius', 'lucid_gateway'
  source_adapter_ver: number
  chain: string
  event_type: string       // 'agent_registered', 'transfer', 'tool_call'
  event_timestamp: string  // ISO 8601
  payload_json: string     // Adapter-specific normalized payload
  block_number?: number
  tx_hash?: string
  log_index?: number
}

export interface AdapterSink {
  writeRawEvent(event: RawAdapterEvent): Promise<void>
  writeRawEvents(events: RawAdapterEvent[]): Promise<void>
  close(): Promise<void>
}
```

### DirectSink (Postgres)

```typescript
// packages/core/src/adapters/direct-sink.ts

export class DirectSink implements AdapterSink {
  constructor(private pool: pg.Pool) {}

  async writeRawEvent(event: RawAdapterEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO oracle_raw_adapter_events
        (event_id, source, source_adapter_ver, chain, event_type,
         event_timestamp, payload_json, block_number, tx_hash, log_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.event_id, event.source, event.source_adapter_ver,
       event.chain, event.event_type, event.event_timestamp,
       event.payload_json, event.block_number, event.tx_hash, event.log_index]
    )
  }

  async writeRawEvents(events: RawAdapterEvent[]): Promise<void> {
    // Batch insert via unnest or multi-row VALUES
    for (const e of events) await this.writeRawEvent(e)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
```

### BrokerSink (future)

```typescript
// packages/core/src/adapters/broker-sink.ts

export class BrokerSink implements AdapterSink {
  constructor(private producer: KafkaProducer, private topic: string) {}

  async writeRawEvent(event: RawAdapterEvent): Promise<void> {
    await this.producer.send({
      topic: this.topic,
      messages: [{ key: `${event.source}:${event.chain}`, value: JSON.stringify(event) }],
    })
  }
  // ...
}
```

### Factory

```typescript
// packages/core/src/adapters/sink-factory.ts

export function createAdapterSink(config: { databaseUrl: string; brokers?: string }): AdapterSink {
  if (config.brokers) {
    return new BrokerSink(/* kafka producer */)
  }
  return new DirectSink(new Pool({ connectionString: config.databaseUrl }))
}
```

One env var (`REDPANDA_BROKERS`) switches the mode. Adapters never know.

## 2. Staging Table

```sql
-- Migration: oracle_raw_adapter_events

CREATE TABLE IF NOT EXISTS oracle_raw_adapter_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  source_adapter_ver INTEGER NOT NULL DEFAULT 1,
  chain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_timestamp TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL,
  block_number BIGINT,
  tx_hash TEXT,
  log_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ  -- NULL = unprocessed
);

CREATE INDEX IF NOT EXISTS idx_raw_adapter_unprocessed
  ON oracle_raw_adapter_events (created_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_raw_adapter_source
  ON oracle_raw_adapter_events (source, chain, event_type);
```

This table is:
- **The audit trail** — every raw event from every adapter, forever
- **The processing queue** — resolver polls `WHERE processed_at IS NULL`
- **The replay source** — set `processed_at = NULL` to reprocess

## 3. Resolver Polling

The existing identity resolver logic (Plan 4A) consumes from this staging table instead of Redpanda topics.

```typescript
// In the API server or a dedicated resolver worker

async function processAdapterEvents(pool: pg.Pool, batchSize = 100): Promise<number> {
  // FOR UPDATE SKIP LOCKED prevents concurrent processing
  const result = await pool.query(
    `SELECT * FROM oracle_raw_adapter_events
     WHERE processed_at IS NULL
     ORDER BY created_at
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize]
  )

  for (const row of result.rows) {
    // Dispatch to existing adapter identity handlers
    await dispatchIdentityEvent(row.source, JSON.parse(row.payload_json), pool)

    // Mark processed
    await pool.query(
      'UPDATE oracle_raw_adapter_events SET processed_at = now() WHERE id = $1',
      [row.id]
    )
  }

  return result.rows.length
}
```

**Poll interval:** Every 5 seconds (configurable). Same non-overlapping loop pattern as the feed worker.

## 4. Watchlist Refresh

Plan 4A uses `wallet_watchlist.updated` Redpanda topic to notify Ponder when new wallets are added to the watchlist. Without a broker:

**Replacement:** Redis PUBLISH on `oracle:watchlist:updated`.

```typescript
// After resolver adds a new wallet mapping:
await redis.publish('oracle:watchlist:updated', JSON.stringify({ chain, address }))
```

Ponder's watchlist consumer subscribes to this Redis channel instead of the Kafka topic. Same semantics (reload from DB on any message), different transport.

If Redis isn't available (e.g., Ponder runs standalone), the watchlist reloads on a timer (every 60s) as a fallback.

## 5. Adapter Changes

### Ponder (ERC-8004 + Base USDC)

**Before:** `publishToERC8004()` → Redpanda topic
**After:** `sink.writeRawEvent()` → staging table

The Ponder event handlers normalize on-chain events into `RawAdapterEvent` and call the sink. No identity logic in Ponder.

### Helius (Solana webhooks)

**Before:** API webhook handler → Redpanda topic
**After:** API webhook handler → `sink.writeRawEvent()` → staging table

The Helius webhook normalizes transactions and writes raw events. The resolver processes them later.

### Gateway poller (existing)

**Before:** Worker polls gateway tables → transforms → inserts to ClickHouse directly
**After:** No change for now. The gateway poller already writes to ClickHouse (OLAP). It can optionally also write identity-relevant events to the staging table for resolver processing.

This is a future enhancement — gateway data already flows through the worker pipeline.

## 6. What Does NOT Change

- `oracle_agent_entities`, `oracle_wallet_mappings`, `oracle_identity_links` schemas
- Identity resolver logic (Plan 4A)
- Conflict detection and resolution (Plan 4B)
- Self-registration challenge flow (Plan 4B)
- ClickHouse raw_economic_events (OLAP path — separate from identity)
- Feed computation pipeline (worker → ClickHouse → API)
- API endpoints, SDK, MCP tools
- Multi-signer attestation

## 7. Migration Path to Broker

When event volume grows and you need a real broker:

1. Set `REDPANDA_BROKERS=broker1:9092` (or Upstash Kafka URL)
2. Factory switches from `DirectSink` → `BrokerSink`
3. Resolver switches from polling staging table → consuming Kafka topic
4. Watchlist refresh switches from Redis PUBLISH → Kafka topic
5. Staging table becomes a dead-letter / audit archive
6. Zero adapter code changes

## 8. Implementation Plan

| Step | What | Depends On |
|------|------|-----------|
| 1 | Create `AdapterSink` interface + `DirectSink` + factory in `packages/core` | — |
| 2 | Create `oracle_raw_adapter_events` migration | — |
| 3 | Add resolver polling loop (reuse existing `dispatchIdentityEvent`) | Steps 1-2 |
| 4 | Refactor Ponder to use `sink.writeRawEvent()` | Step 1 |
| 5 | Refactor Helius adapter to use `sink.writeRawEvent()` | Step 1 |
| 6 | Replace watchlist Kafka consumer with Redis SUBSCRIBE | Step 3 |
| 7 | Deploy Ponder to Railway | Steps 4, 6 |
| 8 | Configure Helius webhook URL | Steps 5, 7 |

Steps 1-3 are foundation. Steps 4-6 are parallel. Steps 7-8 are deployment.

## 9. Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `DATABASE_URL` | Yes | Postgres for staging table + resolver |
| `REDIS_URL` | No | Watchlist refresh notifications (fallback: timer) |
| `REDPANDA_BROKERS` | No | If set, switches to BrokerSink (future) |
| `BASE_RPC_URL` | Yes (Ponder) | QuickNode/Alchemy Base RPC |
| `HELIUS_API_KEY` | Yes (Helius) | Helius webhook auth |
| `HELIUS_WEBHOOK_SECRET` | Yes (Helius) | HMAC verification of incoming webhooks |
| `RESOLVER_POLL_INTERVAL_MS` | No | Default: 5000 |
