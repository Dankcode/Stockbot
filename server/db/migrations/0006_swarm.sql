-- Agent swarm: one paper sleeve per agent, research cycles that Stockbot
-- schedules, retrievals that Stockbot performs itself (receipts), append-only
-- reports with attributed decisions, and order intents that are disabled until
-- the operator turns them on. Additive only: no existing table is altered.

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  runtime TEXT NOT NULL DEFAULT 'hermes',
  hermes_profile TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  intents_enabled INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  retired_at BIGINT,
  CHECK (runtime IN ('hermes')),
  CHECK (status IN ('active', 'paused', 'halted', 'retired')),
  CHECK (intents_enabled IN (0, 1)),
  CHECK (created_by IN ('operator', 'agent'))
);

CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);

CREATE INDEX idx_agent_tokens_agent ON agent_tokens(agent_id, revoked_at);

CREATE TABLE agent_plans (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  activated_at BIGINT,
  superseded_at BIGINT,
  UNIQUE (agent_id, version),
  CHECK (status IN ('draft', 'active', 'superseded')),
  CHECK (created_by IN ('operator', 'agent'))
);

CREATE UNIQUE INDEX idx_agent_plans_one_active
  ON agent_plans(agent_id)
  WHERE status = 'active';

CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  plan_id TEXT NOT NULL REFERENCES agent_plans(id),
  kind TEXT NOT NULL,
  slot TEXT NOT NULL,
  due_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at BIGINT,
  lease_expires_at BIGINT,
  completed_at BIGINT,
  report_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (agent_id, kind, slot),
  CHECK (kind IN ('research')),
  CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'expired')),
  CHECK (created_by IN ('scheduler', 'operator'))
);

CREATE INDEX idx_agent_tasks_due ON agent_tasks(agent_id, status, due_at);

CREATE TABLE retrieval_receipts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  source_kind TEXT NOT NULL,
  request_json TEXT NOT NULL,
  provider TEXT NOT NULL,
  synthetic INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  observed_at BIGINT,
  fetched_at BIGINT NOT NULL,
  CHECK (source_kind IN ('market.quote', 'market.bars', 'web.page')),
  CHECK (synthetic IN (0, 1))
);

CREATE INDEX idx_retrieval_receipts_task ON retrieval_receipts(task_id, fetched_at);

CREATE TABLE agent_reports (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL UNIQUE REFERENCES agent_tasks(id),
  plan_id TEXT NOT NULL REFERENCES agent_plans(id),
  summary TEXT NOT NULL,
  report_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_agent_reports_agent ON agent_reports(agent_id, created_at);

CREATE TABLE report_evidence (
  report_id TEXT NOT NULL REFERENCES agent_reports(id),
  receipt_id TEXT NOT NULL REFERENCES retrieval_receipts(id),
  PRIMARY KEY (report_id, receipt_id)
);

CREATE TABLE agent_decisions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  report_id TEXT NOT NULL REFERENCES agent_reports(id),
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  symbol TEXT NOT NULL,
  action TEXT NOT NULL,
  score INTEGER,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (report_id, symbol),
  CHECK (action IN ('hold', 'buy', 'sell')),
  CHECK (score IS NULL OR (score >= 1 AND score <= 10))
);

CREATE INDEX idx_agent_decisions_agent ON agent_decisions(agent_id, created_at);

CREATE TABLE agent_intents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  decision_id TEXT REFERENCES agent_decisions(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  notional_cents BIGINT,
  qty BIGINT,
  status TEXT NOT NULL,
  client_order_id TEXT NOT NULL UNIQUE,
  order_id TEXT REFERENCES orders(id),
  reject_code TEXT,
  reject_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (agent_id, idempotency_key),
  CHECK (side IN ('buy', 'sell')),
  CHECK (status IN ('received', 'submitting', 'filled', 'rejected', 'broker_rejected'))
);

CREATE INDEX idx_agent_intents_agent ON agent_intents(agent_id, created_at);
CREATE INDEX idx_agent_intents_unresolved ON agent_intents(status, updated_at);

CREATE TABLE swarm_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  acquired_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
