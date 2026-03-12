-- migrations/clickhouse/002_metric_rollups_1m.sql
CREATE TABLE IF NOT EXISTS metric_rollups_1m (
  bucket              DateTime,
  source              LowCardinality(String),
  protocol            LowCardinality(String),
  chain               LowCardinality(String),
  event_type          LowCardinality(String),
  event_count         SimpleAggregateFunction(sum, UInt64),
  authentic_count     SimpleAggregateFunction(sum, UInt64),
  total_usd_value     SimpleAggregateFunction(sum, Decimal64(6)),
  success_count       SimpleAggregateFunction(sum, UInt64),
  error_count         SimpleAggregateFunction(sum, UInt64),
  distinct_subjects   AggregateFunction(uniq, String),
  distinct_subjects_authentic AggregateFunction(uniq, String),
  distinct_providers  AggregateFunction(uniq, String),
  distinct_model_provider_pairs AggregateFunction(uniq, Tuple(String, String)),
  distinct_model_provider_pairs_authentic AggregateFunction(uniq, Tuple(String, String))
) ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(bucket)
ORDER BY (bucket, source, protocol, chain, event_type);

CREATE MATERIALIZED VIEW IF NOT EXISTS metric_rollups_1m_mv TO metric_rollups_1m AS
SELECT
  toStartOfMinute(event_timestamp) AS bucket,
  source, protocol, chain, event_type,
  toUInt64(count()) AS event_count,
  toUInt64(countIf(economic_authentic = 1)) AS authentic_count,
  coalesce(sumIf(assumeNotNull(usd_value), usd_value IS NOT NULL), toDecimal64(0, 6)) AS total_usd_value,
  toUInt64(countIf(status = 'success')) AS success_count,
  toUInt64(countIf(status = 'error')) AS error_count,
  uniqState(coalesce(subject_entity_id, subject_raw_id, '')) AS distinct_subjects,
  uniqStateIf(coalesce(subject_entity_id, subject_raw_id, ''), economic_authentic = 1) AS distinct_subjects_authentic,
  uniqStateIf(assumeNotNull(provider), provider IS NOT NULL) AS distinct_providers,
  uniqStateIf(tuple(assumeNotNull(model_id), assumeNotNull(provider)), model_id IS NOT NULL AND provider IS NOT NULL)
    AS distinct_model_provider_pairs,
  uniqStateIf(tuple(assumeNotNull(model_id), assumeNotNull(provider)), model_id IS NOT NULL AND provider IS NOT NULL AND economic_authentic = 1)
    AS distinct_model_provider_pairs_authentic
FROM raw_economic_events
WHERE corrects_event_id IS NULL
GROUP BY bucket, source, protocol, chain, event_type;
