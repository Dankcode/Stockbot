-- Strategy auto-picks: one row per symbol in a pick job. The pick records which
-- strategy the tournament chose (or that it fell back to buy-and-hold), why, the
-- two backtest experiments the decision rests on, and the paper session it
-- created. Additive only: a new table, nothing existing changes.

CREATE TABLE strategy_picks (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  bar_interval TEXT NOT NULL,
  outcome TEXT,
  algorithm_id TEXT,
  algorithm_version_id TEXT,
  params_json TEXT NOT NULL,
  reason TEXT,
  selection_experiment_id TEXT,
  holdout_experiment_id TEXT,
  evidence_json TEXT NOT NULL,
  session_id TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  CHECK (status IN ('queued', 'selecting', 'confirming', 'completed', 'failed')),
  CHECK (outcome IS NULL OR outcome IN ('selected', 'fallback'))
);

CREATE INDEX idx_strategy_picks_job ON strategy_picks(job_id, created_at);
CREATE INDEX idx_strategy_picks_session ON strategy_picks(session_id);
