// The exact migration history and swarm schema every database test asserts.
// One list, so a new migration fails all four suites the same way instead of
// some of them silently checking a stale prefix.
export const EXPECTED_MIGRATIONS = Object.freeze([
  "0001_init",
  "0002_order_signal_bar",
  "0003_trade_tracker_indexes",
  "0004_ai_research",
  "0005_experiments",
  "0006_swarm",
  "0007_discovery",
  "0008_swarm_experiments"
]);

export const EXPECTED_TABLES = Object.freeze([
  "accounts",
  "agent_decisions",
  "agent_intents",
  "agent_plans",
  "agent_reports",
  "agent_tasks",
  "agent_tokens",
  "agents",
  "alert_deliveries",
  "alerts",
  "algorithm_versions",
  "algorithms",
  "audit_log",
  "backtest_runs",
  "discovery_candidates",
  "discovery_research_requests",
  "discovery_runs",
  "discovery_watchlist",
  "equity_snapshots",
  "experiments",
  "fills",
  "fundamentals_cache",
  "market_daily",
  "market_daily_dates",
  "orders",
  "position_lots",
  "reference_lists",
  "report_evidence",
  "research_documents",
  "research_plan_versions",
  "research_plans",
  "research_runs",
  "research_snapshots",
  "retrieval_receipts",
  "risk_events",
  "risk_profiles",
  "schema_migrations",
  "session_events",
  "session_metrics",
  "sessions",
  "settings",
  "swarm_arms",
  "swarm_benchmark_closes",
  "swarm_equity_snapshots",
  "swarm_experiments",
  "swarm_job_runs",
  "swarm_leases",
  "swarm_reviews"
]);

/** Exact column order of every table 0006 creates. */
export const SWARM_COLUMNS = Object.freeze({
  agents: ["id", "name", "description", "runtime", "hermes_profile", "status", "account_id", "intents_enabled", "created_by", "created_at", "updated_at", "retired_at"],
  agent_tokens: ["id", "agent_id", "token_hash", "scopes_json", "created_at", "last_used_at", "revoked_at"],
  agent_plans: ["id", "agent_id", "version", "content_hash", "plan_json", "status", "created_by", "created_at", "activated_at", "superseded_at"],
  agent_tasks: ["id", "agent_id", "plan_id", "kind", "slot", "due_at", "expires_at", "status", "attempts", "claimed_at", "lease_expires_at", "completed_at", "report_id", "error_code", "error_detail", "created_by", "created_at", "universe_json"],
  retrieval_receipts: ["id", "agent_id", "task_id", "source_kind", "request_json", "provider", "synthetic", "content_hash", "content_json", "observed_at", "fetched_at"],
  agent_reports: ["id", "agent_id", "task_id", "plan_id", "summary", "report_json", "provenance_json", "content_hash", "created_at"],
  report_evidence: ["report_id", "receipt_id"],
  agent_decisions: ["id", "agent_id", "report_id", "task_id", "symbol", "action", "score", "rationale", "evidence_json", "created_at"],
  agent_intents: ["id", "agent_id", "decision_id", "idempotency_key", "request_hash", "symbol", "side", "notional_cents", "qty", "status", "client_order_id", "order_id", "reject_code", "reject_message", "attempts", "created_at", "updated_at", "entry_features_json"],
  swarm_leases: ["name", "holder", "acquired_at", "expires_at"]
});

export const SWARM_INDEXES = Object.freeze([
  "idx_agent_decisions_agent",
  "idx_agent_intents_agent",
  "idx_agent_intents_unresolved",
  "idx_agent_plans_one_active",
  "idx_agent_reports_agent",
  "idx_agent_tasks_due",
  "idx_agent_tokens_agent",
  "idx_retrieval_receipts_task"
]);

/** Exact column order of every table 0007 creates. */
export const DISCOVERY_COLUMNS = Object.freeze({
  reference_lists: ["name", "source", "as_of", "symbols_json", "fetched_at"],
  market_daily: ["date", "symbol", "open", "high", "low", "close", "volume", "vwap"],
  market_daily_dates: ["date", "rows", "source", "fetched_at"],
  fundamentals_cache: ["symbol", "source", "payload_json", "fetched_at"],
  discovery_runs: ["id", "status", "params_json", "progress_json", "stats_json", "error", "created_at", "completed_at"],
  discovery_candidates: ["run_id", "symbol", "name", "exchange", "growth_score", "hold_score", "metrics_json", "fundamentals_json", "scores_json"],
  discovery_watchlist: ["symbol", "status", "note", "source_run_id", "added_at", "updated_at"],
  discovery_research_requests: ["id", "symbol", "status", "question", "researcher", "scrapers_json", "result_json", "error", "created_at", "claimed_at", "completed_at"]
});

/** Exact column order of every table 0008 creates (it also appends universe_json and entry_features_json above). */
export const EXPERIMENT_COLUMNS = Object.freeze({
  swarm_experiments: ["id", "name", "status", "start_date", "config_json", "created_at", "stopped_at"],
  swarm_arms: ["id", "experiment_id", "label", "kind", "agent_id", "account_id", "status", "start_date", "config_json", "created_by", "source_review_id", "created_at", "retired_at", "retire_reason"],
  swarm_equity_snapshots: ["arm_id", "date", "equity", "cash", "positions_json", "taken_at"],
  swarm_benchmark_closes: ["symbol", "date", "close", "source", "fetched_at"],
  swarm_reviews: ["id", "experiment_id", "as_of_date", "trading_days", "verdicts_json", "lessons_json", "lessons_md", "created_arm_id", "created_at"],
  swarm_job_runs: ["job", "slot", "status", "detail_json", "started_at", "finished_at"]
});
