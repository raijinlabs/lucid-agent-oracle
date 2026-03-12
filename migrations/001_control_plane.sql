-- 001_control_plane.sql
-- Control plane tables for the Agent Economy Oracle.
-- These tables live in the same Supabase instance as platform-core (shared DATABASE_URL).
--
-- Tables deferred to later plans:
--   identity_evidence     → Plan 4 (external adapter identity resolution)
--   feed_versions         → Plan 2 (publication plane schema evolution)
--   feed_inputs           → Plan 2 (feed computation pipeline)
--   attestation_jobs      → Plan 2 (on-chain publication)
-- Tables reusing platform-core infrastructure (shared Supabase):
--   api_keys              → reads gateway_api_keys via DATABASE_URL (shared auth)
--   billing_accounts      → reads gateway_tenants plan tiers via DATABASE_URL
--   usage_metering        → own oracle_usage table (Plan 3)
--   mcp_tool_entitlements → Plan 3 (MCP tool registration)

-- Protocol registry: indexed protocols and their contract addresses
CREATE TABLE IF NOT EXISTS oracle_protocol_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chains TEXT[] NOT NULL DEFAULT '{}',
  contract_addresses JSONB NOT NULL DEFAULT '{}',
  adapter_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Agent entities: canonical resolved identities
CREATE TABLE IF NOT EXISTS oracle_agent_entities (
  id TEXT PRIMARY KEY,
  wallet_count INTEGER NOT NULL DEFAULT 0,
  protocol_count INTEGER NOT NULL DEFAULT 0,
  total_economic_output_usd NUMERIC NOT NULL DEFAULT 0,
  reputation_score INTEGER NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallet mappings: wallet → entity resolution
CREATE TABLE IF NOT EXISTS oracle_wallet_mappings (
  wallet_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  confidence NUMERIC NOT NULL DEFAULT 0,
  link_type TEXT NOT NULL CHECK (link_type IN ('explicit_claim', 'onchain_proof', 'gateway_correlation', 'behavioral_heuristic')),
  evidence_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_address, chain)
);
CREATE INDEX IF NOT EXISTS idx_wallet_mappings_entity ON oracle_wallet_mappings(entity_id);

-- Identity links: cross-protocol identity associations
CREATE TABLE IF NOT EXISTS oracle_identity_links (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  external_id TEXT NOT NULL,
  external_system TEXT NOT NULL,
  confidence NUMERIC NOT NULL DEFAULT 0,
  link_type TEXT NOT NULL CHECK (link_type IN ('explicit_claim', 'onchain_proof', 'gateway_correlation', 'behavioral_heuristic')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (external_id, external_system)
);
CREATE INDEX IF NOT EXISTS idx_identity_links_entity ON oracle_identity_links(entity_id);

-- Feed definitions: versioned computation specs
CREATE TABLE IF NOT EXISTS oracle_feed_definitions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  methodology_json JSONB NOT NULL,
  update_interval_ms INTEGER NOT NULL,
  deviation_threshold_bps INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

-- Source connectors: adapter configurations
CREATE TABLE IF NOT EXISTS oracle_source_connectors (
  id TEXT PRIMARY KEY,
  protocol_id TEXT REFERENCES oracle_protocol_registry(id),
  config JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Subscriptions: alerts and webhooks
CREATE TABLE IF NOT EXISTS oracle_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'sse')),
  feed_id TEXT,
  threshold_json JSONB,
  webhook_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON oracle_subscriptions(tenant_id);

-- Seed the protocol registry with known protocols
INSERT INTO oracle_protocol_registry (id, name, chains)
VALUES
  ('lucid', 'Lucid', ARRAY['offchain', 'base', 'solana']),
  ('virtuals', 'Virtuals Protocol', ARRAY['base']),
  ('olas', 'Olas / Autonolas', ARRAY['gnosis', 'base', 'optimism'])
ON CONFLICT (id) DO NOTHING;

-- Seed V1 feed definitions
INSERT INTO oracle_feed_definitions (id, version, name, description, methodology_json, update_interval_ms, deviation_threshold_bps)
VALUES
  ('aegdp', 1, 'Agent Economy GDP', 'Total economic output across all indexed protocols',
   '{"computation": "sum(payments + tasks * avg_value + revenue)", "sources": ["lucid", "virtuals", "olas"]}',
   300000, 100),
  ('aai', 1, 'Agent Activity Index', 'Composite of active agents, tasks/sec, tool calls, unique interactions',
   '{"computation": "weighted_composite(active_agents, tasks_per_sec, tool_calls_per_sec, unique_interactions)", "sources": ["lucid", "virtuals", "olas"]}',
   300000, 200),
  ('apri', 1, 'Agent Protocol Risk Index', 'Bundled health scores, reliability tiers, error rates, concentration',
   '{"computation": "weighted_bundle(protocol_health, agent_reliability, error_rates, concentration)", "sources": ["lucid", "virtuals", "olas"]}',
   300000, 500)
ON CONFLICT (id, version) DO NOTHING;

-- Seed source connectors
INSERT INTO oracle_source_connectors (id, protocol_id, config)
VALUES
  ('lucid_gateway', 'lucid', '{"type": "internal_tap", "tables": ["receipt_events", "mcpgate_audit_log", "gateway_payment_sessions"]}')
ON CONFLICT (id) DO NOTHING;
