-- migrations/clickhouse/001_raw_economic_events.sql
CREATE TABLE IF NOT EXISTS raw_economic_events (
  event_id            String,
  source              LowCardinality(String),
  source_adapter_ver  UInt16,
  ingestion_type      LowCardinality(String),
  ingestion_ts        DateTime64(3),
  chain               LowCardinality(String),
  block_number        Nullable(UInt64),
  tx_hash             Nullable(String),
  log_index           Nullable(UInt32),
  event_type          LowCardinality(String),
  event_timestamp     DateTime64(3),
  subject_entity_id   Nullable(String),
  subject_raw_id      String,
  subject_id_type     LowCardinality(String),
  counterparty_raw_id Nullable(String),
  protocol            LowCardinality(String),
  amount              Nullable(String),
  currency            Nullable(String),
  usd_value           Nullable(Decimal64(6)),
  tool_name           Nullable(String),
  model_id            Nullable(String),
  provider            Nullable(String),
  duration_ms         Nullable(UInt32),
  status              LowCardinality(String),
  quality_score       Float32,
  economic_authentic  UInt8,
  corrects_event_id   Nullable(String),
  correction_reason   Nullable(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(event_timestamp)
ORDER BY (source, chain, event_type, event_timestamp, event_id);
