// The exact migration history and swarm schema every database test asserts.
// One list, so a new migration fails all four suites the same way instead of
// some of them silently checking a stale prefix.
export const EXPECTED_MIGRATIONS = Object.freeze([
  "0001_init",
  "0002_order_signal_bar",
  "0003_trade_tracker_indexes",
  "0004_ai_research",
  "0005_experiments",
  "0006_swarm"
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
  "equity_snapshots",
  "experiments",
  "fills",
  "orders",
  "position_lots",
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
  "swarm_leases"
]);

/** Exact column order of every table 0006 creates. */
export const SWARM_COLUMNS = Object.freeze({
  agents: ["id", "name", "description", "runtime", "hermes_profile", "status", "account_id", "intents_enabled", "created_by", "created_at", "updated_at", "retired_at"],
  agent_tokens: ["id", "agent_id", "token_hash", "scopes_json", "created_at", "last_used_at", "revoked_at"],
  agent_plans: ["id", "agent_id", "version", "content_hash", "plan_json", "status", "created_by", "created_at", "activated_at", "superseded_at"],
  agent_tasks: ["id", "agent_id", "plan_id", "kind", "slot", "due_at", "expires_at", "status", "attempts", "claimed_at", "lease_expires_at", "completed_at", "report_id", "error_code", "error_detail", "created_by", "created_at"],
  retrieval_receipts: ["id", "agent_id", "task_id", "source_kind", "request_json", "provider", "synthetic", "content_hash", "content_json", "observed_at", "fetched_at"],
  agent_reports: ["id", "agent_id", "task_id", "plan_id", "summary", "report_json", "provenance_json", "content_hash", "created_at"],
  report_evidence: ["report_id", "receipt_id"],
  agent_decisions: ["id", "agent_id", "report_id", "task_id", "symbol", "action", "score", "rationale", "evidence_json", "created_at"],
  agent_intents: ["id", "agent_id", "decision_id", "idempotency_key", "request_hash", "symbol", "side", "notional_cents", "qty", "status", "client_order_id", "order_id", "reject_code", "reject_message", "attempts", "created_at", "updated_at"],
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
