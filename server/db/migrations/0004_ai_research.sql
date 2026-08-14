CREATE TABLE research_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_research_plans_created
  ON research_plans(created_at, id);

CREATE TABLE research_plan_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES research_plans(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (plan_id, source_hash)
);

CREATE INDEX idx_research_plan_versions_plan
  ON research_plan_versions(plan_id, created_at, id);

CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  plan_version_id TEXT NOT NULL REFERENCES research_plan_versions(id),
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  request_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  started_at BIGINT,
  completed_at BIGINT,
  error_code TEXT,
  error_detail TEXT,
  created_at BIGINT NOT NULL,
  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  CHECK (
    (status = 'pending' AND started_at IS NULL AND completed_at IS NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL) OR
    (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL) OR
    (status = 'failed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_research_runs_plan_symbol
  ON research_runs(plan_version_id, symbol, created_at, id);

CREATE INDEX idx_research_runs_plan
  ON research_runs(plan_version_id, created_at, id);

CREATE INDEX idx_research_runs_symbol
  ON research_runs(symbol, created_at, id);

CREATE INDEX idx_research_runs_status
  ON research_runs(status, created_at, id);

CREATE TABLE research_documents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  published_at BIGINT,
  retrieved_at BIGINT NOT NULL,
  content_hash TEXT NOT NULL,
  content_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_research_documents_run
  ON research_documents(run_id, retrieved_at, id);

CREATE INDEX idx_research_documents_content
  ON research_documents(run_id, content_hash, id);

CREATE TABLE research_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  plan_version_id TEXT NOT NULL REFERENCES research_plan_versions(id),
  symbol TEXT NOT NULL,
  available_at BIGINT NOT NULL,
  summary_text TEXT NOT NULL,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  source_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  eligible INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  CHECK (eligible IN (0, 1)),
  UNIQUE (run_id)
);

CREATE INDEX idx_research_snapshots_run
  ON research_snapshots(run_id, created_at, id);

CREATE INDEX idx_research_snapshots_eligible
  ON research_snapshots(plan_version_id, symbol, eligible, available_at, created_at, id);

CREATE INDEX idx_research_snapshots_timeline
  ON research_snapshots(plan_version_id, symbol, available_at, created_at, id);

ALTER TABLE sessions
  ADD COLUMN research_plan_version_id TEXT REFERENCES research_plan_versions(id) ON DELETE SET NULL;

CREATE INDEX idx_sessions_research_plan_version
  ON sessions(research_plan_version_id, created_at, id);

ALTER TABLE orders
  ADD COLUMN research_snapshot_id TEXT REFERENCES research_snapshots(id) ON DELETE SET NULL;

CREATE INDEX idx_orders_research_snapshot
  ON orders(research_snapshot_id, submitted_at, id);
