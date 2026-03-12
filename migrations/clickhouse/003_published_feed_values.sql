-- migrations/clickhouse/003_published_feed_values.sql
CREATE TABLE IF NOT EXISTS published_feed_values (
  feed_id             LowCardinality(String),
  feed_version        UInt16,
  computed_at         DateTime64(3),
  revision            UInt16 DEFAULT 0,
  value_json          String,
  value_usd           Nullable(Float64),
  value_index         Nullable(Float64),
  confidence          Float32,
  completeness        Float32,
  freshness_ms        UInt32,
  staleness_risk      LowCardinality(String),
  revision_status     LowCardinality(String) DEFAULT 'preliminary',
  methodology_version UInt16,
  input_manifest_hash String,
  computation_hash    String,
  signer_set_id       String,
  signatures_json     String,
  source_coverage     String,
  published_solana    Nullable(String),
  published_base      Nullable(String)
) ENGINE = ReplacingMergeTree(revision)
ORDER BY (feed_id, feed_version, computed_at);
