-- Phase A: Agent Universe Dashboard — enrichment tables + schema additions.
-- Token balances, economy snapshots, and agent profile enrichment.

-- 1. Token balance tracking per agent wallet
CREATE TABLE IF NOT EXISTS oracle_wallet_balances (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  token_decimals INTEGER,
  balance_raw TEXT NOT NULL DEFAULT '0',
  balance_usd NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, wallet_address, token_address)
);

CREATE INDEX IF NOT EXISTS idx_wallet_balances_entity
  ON oracle_wallet_balances (agent_entity);
CREATE INDEX IF NOT EXISTS idx_wallet_balances_usd
  ON oracle_wallet_balances (balance_usd DESC)
  WHERE balance_usd > 0;

-- 2. Economy-wide snapshots (hourly)
CREATE TABLE IF NOT EXISTS oracle_economy_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_agents INTEGER NOT NULL DEFAULT 0,
  active_agents_24h INTEGER NOT NULL DEFAULT 0,
  total_wallets INTEGER NOT NULL DEFAULT 0,
  total_tvl_usd NUMERIC NOT NULL DEFAULT 0,
  tx_volume_24h_usd NUMERIC NOT NULL DEFAULT 0,
  tx_count_24h INTEGER NOT NULL DEFAULT 0,
  new_agents_7d INTEGER NOT NULL DEFAULT 0,
  avg_reputation_score NUMERIC,
  top_tokens_json JSONB
);

CREATE INDEX IF NOT EXISTS idx_economy_snapshots_at
  ON oracle_economy_snapshots (snapshot_at DESC);

-- 3. Enrich agent entities with dashboard fields
ALTER TABLE oracle_agent_entities
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT;

-- 4. Enrich wallet transactions with gas data
ALTER TABLE oracle_wallet_transactions
  ADD COLUMN IF NOT EXISTS gas_used NUMERIC,
  ADD COLUMN IF NOT EXISTS gas_price NUMERIC;
