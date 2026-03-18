-- migrations/002_worker_checkpoints.sql
CREATE TABLE IF NOT EXISTS oracle_worker_checkpoints (
  source_table     TEXT PRIMARY KEY,
  watermark_column TEXT NOT NULL DEFAULT 'created_at',
  last_seen_ts     TIMESTAMPTZ NOT NULL,
  last_seen_id     TEXT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO oracle_worker_checkpoints (source_table, watermark_column, last_seen_ts, last_seen_id)
VALUES
  ('receipt_events',          'created_at', '1970-01-01T00:00:00Z', ''),
  ('mcpgate_audit_log',       'created_at', '1970-01-01T00:00:00Z', ''),
  ('gateway_payment_sessions','created_at',  '1970-01-01T00:00:00Z', '')
ON CONFLICT (source_table) DO NOTHING;
