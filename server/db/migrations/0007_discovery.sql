-- Ticker discovery: reference lists (S&P 500 membership), stored whole-market
-- daily rows (liquidity now, point-in-time screens later), a fundamentals
-- cache, discovery runs with their scored candidates, the watchlist pipeline,
-- and research requests that an assigned LLM researcher will work through.
-- Additive only.

CREATE TABLE reference_lists (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  as_of TEXT,
  symbols_json TEXT NOT NULL,
  fetched_at BIGINT NOT NULL
);

CREATE TABLE market_daily (
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  open DOUBLE PRECISION,
  high DOUBLE PRECISION,
  low DOUBLE PRECISION,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL,
  vwap DOUBLE PRECISION,
  PRIMARY KEY (date, symbol)
);

CREATE TABLE market_daily_dates (
  date TEXT PRIMARY KEY,
  rows INTEGER NOT NULL,
  source TEXT NOT NULL,
  fetched_at BIGINT NOT NULL
);

CREATE TABLE fundamentals_cache (
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at BIGINT NOT NULL,
  PRIMARY KEY (symbol, source)
);

CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  params_json TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  stats_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX idx_discovery_runs_created ON discovery_runs(created_at);

CREATE TABLE discovery_candidates (
  run_id TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  name TEXT,
  exchange TEXT,
  growth_score INTEGER,
  hold_score INTEGER,
  metrics_json TEXT NOT NULL,
  fundamentals_json TEXT,
  scores_json TEXT NOT NULL,
  PRIMARY KEY (run_id, symbol)
);

CREATE INDEX idx_discovery_candidates_growth ON discovery_candidates(run_id, growth_score);
CREATE INDEX idx_discovery_candidates_hold ON discovery_candidates(run_id, hold_score);

CREATE TABLE discovery_watchlist (
  symbol TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  note TEXT,
  source_run_id TEXT,
  added_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (status IN ('watching', 'researching', 'shortlisted', 'holding', 'rejected'))
);

CREATE TABLE discovery_research_requests (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  question TEXT,
  researcher TEXT,
  scrapers_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  error TEXT,
  created_at BIGINT NOT NULL,
  claimed_at BIGINT,
  completed_at BIGINT,
  CHECK (status IN ('pending', 'claimed', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX idx_discovery_research_status ON discovery_research_requests(status, created_at);
CREATE INDEX idx_discovery_research_symbol ON discovery_research_requests(symbol, created_at);
