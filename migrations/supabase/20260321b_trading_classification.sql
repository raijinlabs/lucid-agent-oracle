-- Honest trade classification + price observation layer.
-- Fixes: don't call execution delta "profit", add confidence scoring.

-- Expand tx_type to include non-swap classifications
ALTER TABLE oracle_wallet_transactions
  DROP CONSTRAINT IF EXISTS oracle_wallet_transactions_tx_type_check;
ALTER TABLE oracle_wallet_transactions
  ADD CONSTRAINT oracle_wallet_transactions_tx_type_check
  CHECK (tx_type IN ('transfer', 'swap', 'multi_hop_swap', 'lp_add', 'lp_remove', 'bridge', 'contract_interaction', 'unknown'));

-- Classification confidence (how sure are we this is a swap vs LP vs bridge)
ALTER TABLE oracle_wallet_transactions
  ADD COLUMN IF NOT EXISTS classification_confidence TEXT CHECK (classification_confidence IN ('high', 'medium', 'low')) DEFAULT 'low';

-- Execution delta (NOT profit — just what went in vs out in this tx)
ALTER TABLE oracle_wallet_transactions
  ADD COLUMN IF NOT EXISTS execution_delta_usd NUMERIC;

-- Valuation confidence (how sure are we about the USD value)
ALTER TABLE oracle_wallet_transactions
  ADD COLUMN IF NOT EXISTS valuation_confidence TEXT CHECK (valuation_confidence IN ('exact', 'high', 'medium', 'low', 'none'));

-- Price observations — derived from swap data + external feeds
-- Every time we see a swap with a stablecoin leg, we can derive a price
CREATE TABLE IF NOT EXISTS oracle_price_observations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  price_usd NUMERIC NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stablecoin_leg', 'external_feed', 'base_asset_derived')),
  confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'high', 'medium', 'low')),
  observed_at TIMESTAMPTZ NOT NULL,
  block_number BIGINT,
  tx_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_obs_token
  ON oracle_price_observations (chain, token_address, observed_at DESC);

-- Update token registry with valuation tier
ALTER TABLE oracle_token_registry
  ADD COLUMN IF NOT EXISTS valuation_tier TEXT CHECK (valuation_tier IN ('tier1_exact', 'tier2_market', 'tier3_derived')) DEFAULT 'tier3_derived';

-- Mark known stablecoins as tier1
UPDATE oracle_token_registry SET valuation_tier = 'tier1_exact' WHERE is_stablecoin = true;
UPDATE oracle_token_registry SET valuation_tier = 'tier2_market' WHERE is_base_asset = true;
