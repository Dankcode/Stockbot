CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  bar_interval TEXT NOT NULL,
  window_start BIGINT,
  window_end BIGINT,
  fill_model_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  selection_json TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_experiments_created ON experiments(created_at, id);

ALTER TABLE sessions
  ADD COLUMN experiment_id TEXT REFERENCES experiments(id) ON DELETE CASCADE;

ALTER TABLE sessions
  ADD COLUMN experiment_arm TEXT;

ALTER TABLE sessions
  ADD COLUMN experiment_arm_id TEXT;

CREATE INDEX idx_sessions_experiment ON sessions(experiment_id, experiment_arm, created_at, id);

CREATE UNIQUE INDEX idx_sessions_experiment_arm
  ON sessions(experiment_id, experiment_arm_id)
  WHERE experiment_id IS NOT NULL;
