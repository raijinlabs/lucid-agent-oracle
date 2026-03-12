-- migrations/003_update_feed_methodology.sql
-- Updates AAI and APRI methodology_json to match Plan 2A spec

UPDATE oracle_feed_definitions
SET methodology_json = jsonb_build_object(
  'type', 'activity_index',
  'version', 1,
  'range', jsonb_build_array(0, 1000),
  'sub_metrics', jsonb_build_object(
    'active_agents', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 100),
    'throughput_per_second', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 10),
    'authentic_tool_call_volume', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 10000),
    'model_provider_diversity', jsonb_build_object('weight', 0.25, 'normalization', 'log10', 'anchor', 50)
  ),
  'filter', 'economic_authentic = true'
)
WHERE id = 'aai' AND version = 1;

UPDATE oracle_feed_definitions
SET methodology_json = jsonb_build_object(
  'type', 'risk_index',
  'version', 1,
  'range_bps', jsonb_build_array(0, 10000),
  'dimensions', jsonb_build_object(
    'error_rate', jsonb_build_object('weight', 0.30, 'scope', 'llm_inference + tool_call'),
    'provider_concentration', jsonb_build_object('weight', 0.25, 'method', 'HHI', 'scope', 'provider IS NOT NULL'),
    'authenticity_ratio', jsonb_build_object('weight', 0.25, 'scope', 'all events'),
    'activity_continuity', jsonb_build_object('weight', 0.20, 'scope', 'all events', 'bucket_size_ms', 60000)
  ),
  'scaling', 'raw_fraction * 10000'
)
WHERE id = 'apri' AND version = 1;
