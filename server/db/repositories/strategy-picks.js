import { assertClient, boundedLimit, first, hydrateRows, toJson } from "./_helpers.js";

const JSON_FIELDS = ["paramsJson", "evidenceJson"];
const UPDATABLE = Object.freeze({
  status: "status",
  outcome: "outcome",
  algorithmId: "algorithm_id",
  algorithmVersionId: "algorithm_version_id",
  params: "params_json",
  reason: "reason",
  selectionExperimentId: "selection_experiment_id",
  holdoutExperimentId: "holdout_experiment_id",
  evidence: "evidence_json",
  sessionId: "session_id",
  error: "error",
  completedAt: "completed_at"
});

/** SQL for strategy auto-picks: one row per symbol in a pick job. */
export function createStrategyPicksRepository(client) {
  assertClient(client);
  const repository = {
    async create(input) {
      await client.execute(
        `INSERT INTO strategy_picks (id, job_id, symbol, status, bar_interval, outcome, algorithm_id, algorithm_version_id,
           params_json, reason, selection_experiment_id, holdout_experiment_id, evidence_json, session_id, error,
           created_at, updated_at, completed_at)
         VALUES (?, ?, ?, 'queued', ?, NULL, NULL, NULL, '{}', NULL, NULL, NULL, '{}', NULL, NULL, ?, ?, NULL)`,
        [input.id, input.jobId, input.symbol, input.barInterval, input.createdAt, input.createdAt]
      );
      return repository.getById(input.id);
    },
    async getById(id) {
      return first(await client.query("SELECT * FROM strategy_picks WHERE id = ?", [id]), JSON_FIELDS);
    },
    async update(id, changes, at) {
      const sets = [];
      const values = [];
      for (const [key, column] of Object.entries(UPDATABLE)) {
        if (!Object.hasOwn(changes, key)) continue;
        sets.push(`${column} = ?`);
        const value = changes[key];
        values.push(column.endsWith("_json") ? toJson(value) : value ?? null);
      }
      sets.push("updated_at = ?");
      values.push(at);
      await client.execute(`UPDATE strategy_picks SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
      return repository.getById(id);
    },
    async listByJob(jobId) {
      return hydrateRows(await client.query("SELECT * FROM strategy_picks WHERE job_id = ? ORDER BY created_at, id", [jobId]), JSON_FIELDS);
    },
    async getBySession(sessionId) {
      return first(await client.query("SELECT * FROM strategy_picks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1", [sessionId]), JSON_FIELDS);
    },
    async list({ limit } = {}) {
      return hydrateRows(await client.query("SELECT * FROM strategy_picks ORDER BY created_at DESC, id LIMIT ?", [boundedLimit(limit, 50, 250)]), JSON_FIELDS);
    },
    /** Rows a crashed process left mid-flight; nothing will ever finish them. */
    async failUnfinished({ at, error }) {
      const result = await client.execute(
        "UPDATE strategy_picks SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE status IN ('queued', 'selecting', 'confirming')",
        [error, at, at]
      );
      return result.changes ?? 0;
    }
  };
  return Object.freeze(repository);
}
