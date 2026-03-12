-- Plan 4A: Agent Identity Tables
-- Creates agent_entities, wallet_mappings, and identity_links tables
-- for the deterministic identity resolver.

-- Canonical agent identity records
CREATE TABLE IF NOT EXISTS agent_entities (
  id                    TEXT PRIMARY KEY,
  display_name          TEXT,
  erc8004_id            TEXT UNIQUE,
  lucid_tenant          TEXT,
  reputation_json       JSONB,
  reputation_updated_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_entities_erc8004
  ON agent_entities(erc8004_id) WHERE erc8004_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_entities_lucid
  ON agent_entities(lucid_tenant) WHERE lucid_tenant IS NOT NULL;

-- Wallet → agent entity resolution
CREATE TABLE IF NOT EXISTS wallet_mappings (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity  TEXT NOT NULL REFERENCES agent_entities(id),
  chain         TEXT NOT NULL,
  address       TEXT NOT NULL,
  link_type     TEXT NOT NULL,
  confidence    REAL DEFAULT 1.0,
  evidence_hash TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  removed_at    TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS wallet_mappings_active_address
  ON wallet_mappings(chain, address) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_mappings_entity
  ON wallet_mappings(agent_entity);

-- Cross-protocol identity links
CREATE TABLE IF NOT EXISTS identity_links (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity    TEXT NOT NULL REFERENCES agent_entities(id),
  protocol        TEXT NOT NULL,
  protocol_id     TEXT NOT NULL,
  link_type       TEXT NOT NULL,
  confidence      REAL DEFAULT 1.0,
  evidence_json   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (protocol, protocol_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_links_entity
  ON identity_links(agent_entity);
