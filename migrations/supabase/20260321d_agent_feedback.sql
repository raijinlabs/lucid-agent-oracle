-- Agent feedback from ERC-8004 Reputation Registry.
-- Stores trust signals, ratings, and evidence per agent.

CREATE TABLE IF NOT EXISTS oracle_agent_feedback (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_entity TEXT NOT NULL REFERENCES oracle_agent_entities(id),
  chain TEXT NOT NULL DEFAULT 'base',
  client_address TEXT NOT NULL,
  feedback_index INTEGER NOT NULL,
  value INTEGER NOT NULL,               -- rating value (int128 on-chain, stored as int)
  value_decimals SMALLINT DEFAULT 0,
  tag1 TEXT,                            -- e.g. "trust", "performance", "reliability"
  tag2 TEXT,                            -- e.g. "oracle-screening", "manual-review"
  endpoint TEXT,                        -- service endpoint that was rated
  feedback_uri TEXT,                    -- off-chain evidence URL
  feedback_hash TEXT,                   -- evidence hash (bytes32)
  tx_hash TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  event_timestamp TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_entity, chain, feedback_index)
);

CREATE INDEX IF NOT EXISTS idx_agent_feedback_entity
  ON oracle_agent_feedback (agent_entity);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_tag
  ON oracle_agent_feedback (tag1);
CREATE INDEX IF NOT EXISTS idx_agent_feedback_timestamp
  ON oracle_agent_feedback (event_timestamp DESC);
