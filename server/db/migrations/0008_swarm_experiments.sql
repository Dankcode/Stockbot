-- Swarm experiments: a frozen universe on every research task, the Discovery
-- features behind every buy, experiment arms (LLM agents and a mechanical
-- index control) with their daily equity, benchmark closes, the periodic
-- review that retires failing arms and records what was learned, and an
-- idempotency table for the swarm's daily jobs. Additive only: two nullable
-- columns on existing tables, no existing row or constraint changes.

ALTER TABLE agent_tasks ADD COLUMN universe_json TEXT;
ALTER TABLE agent_intents ADD COLUMN entry_features_json TEXT;

CREATE TABLE swarm_experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  stopped_at BIGINT,
  CHECK (status IN ('active', 'stopped'))
);

CREATE TABLE swarm_arms (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES swarm_experiments(id),
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  status TEXT NOT NULL,
  start_date TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  source_review_id TEXT,
  created_at BIGINT NOT NULL,
  retired_at BIGINT,
  retire_reason TEXT,
  UNIQUE (experiment_id, label),
  CHECK (kind IN ('agent', 'control')),
  CHECK (status IN ('active', 'retired')),
  CHECK (created_by IN ('operator', 'review')),
  CHECK ((kind = 'agent' AND agent_id IS NOT NULL) OR (kind = 'control' AND agent_id IS NULL))
);

CREATE INDEX idx_swarm_arms_experiment ON swarm_arms(experiment_id, status);

CREATE TABLE swarm_equity_snapshots (
  arm_id TEXT NOT NULL REFERENCES swarm_arms(id),
  date TEXT NOT NULL,
  equity BIGINT NOT NULL,
  cash BIGINT NOT NULL,
  positions_json TEXT NOT NULL,
  taken_at BIGINT NOT NULL,
  PRIMARY KEY (arm_id, date)
);

CREATE TABLE swarm_benchmark_closes (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE swarm_reviews (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES swarm_experiments(id),
  as_of_date TEXT NOT NULL,
  trading_days INTEGER NOT NULL,
  verdicts_json TEXT NOT NULL,
  lessons_json TEXT NOT NULL,
  lessons_md TEXT NOT NULL,
  created_arm_id TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE (experiment_id, as_of_date)
);

CREATE TABLE swarm_job_runs (
  job TEXT NOT NULL,
  slot TEXT NOT NULL,
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT,
  PRIMARY KEY (job, slot),
  CHECK (status IN ('running', 'completed', 'failed', 'skipped'))
);
