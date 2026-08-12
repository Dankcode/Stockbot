CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at BIGINT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  starting_cash BIGINT NOT NULL,
  cash BIGINT NOT NULL,
  realized_pnl BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  archived_at BIGINT,
  CHECK (mode IN ('paper', 'live'))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  CHECK (is_secret IN (0, 1))
);

CREATE TABLE algorithms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT,
  description TEXT,
  source_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  CHECK (enabled IN (0, 1))
);

CREATE TABLE algorithm_versions (
  id TEXT PRIMARY KEY,
  algorithm_id TEXT NOT NULL REFERENCES algorithms(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_code TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  UNIQUE (algorithm_id, source_hash)
);

CREATE INDEX idx_algorithm_versions_algorithm
  ON algorithm_versions(algorithm_id, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  algorithm_version_id TEXT REFERENCES algorithm_versions(id),
  params_json TEXT NOT NULL DEFAULT '{}',
  symbols_json TEXT NOT NULL,
  bar_interval TEXT NOT NULL,
  window_start BIGINT,
  window_end BIGINT,
  fill_model_json TEXT NOT NULL,
  risk_profile_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  starting_equity BIGINT NOT NULL,
  ending_equity BIGINT,
  started_at BIGINT,
  ended_at BIGINT,
  stop_reason TEXT,
  error_detail TEXT,
  created_at BIGINT NOT NULL,
  CHECK (mode IN ('backtest', 'paper')),
  CHECK (status IN ('draft', 'arming', 'running', 'paused', 'stopping', 'halted', 'stopped', 'errored'))
);

CREATE INDEX idx_sessions_account ON sessions(account_id, started_at);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_algorithm ON sessions(algorithm_version_id, created_at);

CREATE TABLE session_metrics (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  computed_at BIGINT NOT NULL,
  metrics_version TEXT NOT NULL,
  return_percent REAL,
  final_equity BIGINT,
  max_drawdown REAL,
  sharpe REAL,
  sortino REAL,
  profit_factor REAL,
  win_rate REAL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  exposure_percent REAL,
  avg_trade_percent REAL,
  UNIQUE (session_id, metrics_version)
);

CREATE TABLE session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at BIGINT NOT NULL,
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_session_events_session ON session_events(session_id, at);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL UNIQUE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL DEFAULT 'market',
  qty BIGINT NOT NULL,
  limit_price BIGINT,
  status TEXT NOT NULL,
  reject_reason TEXT,
  signal_reason TEXT,
  submitted_at BIGINT NOT NULL,
  resolved_at BIGINT,
  CHECK (side IN ('buy', 'sell')),
  CHECK (status IN ('pending', 'filled', 'partial', 'rejected', 'canceled'))
);

CREATE INDEX idx_orders_session ON orders(session_id, submitted_at);
CREATE INDEX idx_orders_symbol ON orders(account_id, symbol, submitted_at);

CREATE TABLE fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  qty BIGINT NOT NULL,
  price BIGINT NOT NULL,
  reference_price BIGINT NOT NULL,
  commission BIGINT NOT NULL DEFAULT 0,
  filled_at BIGINT NOT NULL,
  quote_age_ms BIGINT
);

CREATE INDEX idx_fills_order ON fills(order_id, filled_at);

CREATE TABLE position_lots (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  symbol TEXT NOT NULL,
  qty_open BIGINT NOT NULL,
  qty_original BIGINT NOT NULL,
  entry_price BIGINT NOT NULL,
  entry_order_id TEXT REFERENCES orders(id),
  exit_price BIGINT,
  exit_order_id TEXT REFERENCES orders(id),
  realized_pnl BIGINT,
  opened_at BIGINT NOT NULL,
  closed_at BIGINT
);

CREATE INDEX idx_lots_open ON position_lots(account_id, symbol, closed_at);
CREATE INDEX idx_lots_session ON position_lots(session_id, opened_at);

CREATE TABLE equity_snapshots (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at BIGINT NOT NULL,
  equity BIGINT NOT NULL,
  cash BIGINT NOT NULL,
  position_value BIGINT NOT NULL,
  drawdown_percent REAL NOT NULL,
  PRIMARY KEY (session_id, at)
);

CREATE TABLE backtest_runs (
  id TEXT PRIMARY KEY,
  algorithm_version_id TEXT NOT NULL REFERENCES algorithm_versions(id),
  symbol TEXT NOT NULL,
  bar_interval TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  window_end BIGINT NOT NULL,
  bars_hash TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  fill_model_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  computed_at BIGINT NOT NULL,
  compute_ms BIGINT,
  UNIQUE (
    algorithm_version_id,
    symbol,
    bar_interval,
    window_start,
    window_end,
    bars_hash,
    params_hash,
    fill_model_hash
  )
);

CREATE TABLE risk_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  CHECK (is_default IN (0, 1))
);

CREATE INDEX idx_risk_profiles_account ON risk_profiles(account_id, is_default);

CREATE TABLE risk_events (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  at BIGINT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  CHECK (severity IN ('info', 'warn', 'block', 'halt')),
  CHECK (action_taken IN ('logged', 'order_rejected', 'session_halted', 'liquidated'))
);

CREATE INDEX idx_risk_events_session ON risk_events(session_id, at);
CREATE INDEX idx_risk_events_account ON risk_events(account_id, at);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  cooldown_ms BIGINT NOT NULL DEFAULT 0,
  last_fired_at BIGINT,
  created_at BIGINT NOT NULL,
  CHECK (trigger_type IN ('metric_threshold', 'risk_event', 'session_state', 'signal', 'schedule')),
  CHECK (channel IN ('in_app', 'webhook', 'email')),
  CHECK (enabled IN (0, 1))
);

CREATE INDEX idx_alerts_account ON alerts(account_id, enabled);

CREATE TABLE alert_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  at BIGINT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error_detail TEXT,
  read_at BIGINT,
  CHECK (status IN ('sent', 'failed', 'suppressed'))
);

CREATE INDEX idx_deliveries_alert ON alert_deliveries(alert_id, at);
CREATE INDEX idx_deliveries_session ON alert_deliveries(session_id, at);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT
);

CREATE INDEX idx_audit_at ON audit_log(at);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id, at);
