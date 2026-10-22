/** Tables that existed before the swarm migration (0001–0005). */
export const PRE_SWARM_TABLES = Object.freeze([
  "accounts", "alert_deliveries", "alerts", "algorithm_versions", "algorithms", "audit_log", "backtest_runs",
  "equity_snapshots", "experiments", "fills", "orders", "position_lots", "research_documents", "research_plan_versions",
  "research_plans", "research_runs", "research_snapshots", "risk_events", "risk_profiles", "session_events",
  "session_metrics", "sessions", "settings"
]);

/** PostgreSQL: order-independent row count + digest of every row in each table. */
export async function fingerprintTables(client, tables = PRE_SWARM_TABLES) {
  if (client.dialect !== "postgres") throw new Error("Table fingerprints are implemented for PostgreSQL.");
  const result = {};
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error(`Invalid table name ${table}.`);
    const [row] = await client.query(
      `SELECT COUNT(*) AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS digest FROM ${table} t`
    );
    result[table] = `${row.rows}:${row.digest}`;
  }
  return result;
}

export function diffFingerprints(before, after) {
  return Object.keys({ ...before, ...after }).filter((table) => before[table] !== after[table]).sort();
}
