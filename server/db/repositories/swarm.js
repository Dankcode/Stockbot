import { assertClient, boundedLimit, first, hydrateRows, toJson } from "./_helpers.js";

const PLAN_JSON = ["planJson"];
const TOKEN_JSON = ["scopesJson"];
const RECEIPT_JSON = ["requestJson", "contentJson"];
const REPORT_JSON = ["reportJson", "provenanceJson"];
const DECISION_JSON = ["evidenceJson"];

function bool(row, field) {
  if (row) row[field] = Number(row[field]) === 1;
  return row;
}

/** SQL for agents, sleeves, plans, tasks, receipts, reports, decisions and intents. */
export function createSwarmRepository(client) {
  assertClient(client);
  const agentRow = (row) => bool(row, "intentsEnabled");

  const repository = {
    async insertAgent(input) {
      await client.execute(
        `INSERT INTO agents (id, name, description, runtime, hermes_profile, status, account_id,
           intents_enabled, created_by, created_at, updated_at, retired_at)
         VALUES (?, ?, ?, 'hermes', ?, ?, ?, 0, ?, ?, ?, NULL)`,
        [input.id, input.name, input.description ?? null, input.hermesProfile, input.status ?? "active",
          input.accountId, input.createdBy ?? "operator", input.createdAt, input.createdAt]
      );
      return repository.getAgent(input.id);
    },
    async getAgent(id) {
      return agentRow(first(await client.query("SELECT * FROM agents WHERE id = ?", [id])));
    },
    async getAgentByName(name) {
      return agentRow(first(await client.query("SELECT * FROM agents WHERE name = ?", [name])));
    },
    async listAgents({ includeRetired = false } = {}) {
      const rows = await client.query(
        includeRetired
          ? "SELECT * FROM agents ORDER BY created_at, id"
          : "SELECT * FROM agents WHERE status <> 'retired' ORDER BY created_at, id"
      );
      return hydrateRows(rows).map(agentRow);
    },
    async countAgents() {
      const rows = await client.query("SELECT COUNT(*) AS count FROM agents WHERE status <> 'retired'");
      return Number(rows[0]?.count ?? 0);
    },
    async updateAgent(id, { status, intentsEnabled, at }) {
      await client.execute(
        `UPDATE agents
         SET status = COALESCE(?, status),
             intents_enabled = COALESCE(?, intents_enabled),
             retired_at = CASE WHEN ? = 'retired' THEN ? ELSE retired_at END,
             updated_at = ?
         WHERE id = ?`,
        [status ?? null, intentsEnabled === undefined ? null : intentsEnabled ? 1 : 0, status ?? null, at, at, id]
      );
      return repository.getAgent(id);
    },

    async insertToken(input) {
      await client.execute(
        `INSERT INTO agent_tokens (id, agent_id, token_hash, scopes_json, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
        [input.id, input.agentId, input.tokenHash, toJson(input.scopes, []), input.createdAt]
      );
    },
    async findTokenByHash(tokenHash) {
      return first(await client.query("SELECT * FROM agent_tokens WHERE token_hash = ?", [tokenHash]), TOKEN_JSON);
    },
    async touchToken(id, at) {
      await client.execute("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?", [at, id]);
    },
    async revokeTokens(agentId, at) {
      const result = await client.execute(
        "UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL",
        [at, agentId]
      );
      return result.changes;
    },
    async listTokens(agentId) {
      return hydrateRows(await client.query(
        "SELECT id, agent_id, scopes_json, created_at, last_used_at, revoked_at FROM agent_tokens WHERE agent_id = ? ORDER BY created_at",
        [agentId]
      ), TOKEN_JSON);
    },

    async nextPlanVersion(agentId) {
      const rows = await client.query("SELECT MAX(version) AS version FROM agent_plans WHERE agent_id = ?", [agentId]);
      return Number(rows[0]?.version ?? 0) + 1;
    },
    async insertPlan(input) {
      await client.execute(
        `INSERT INTO agent_plans (id, agent_id, version, content_hash, plan_json, status, created_by, created_at, activated_at, superseded_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, NULL)`,
        [input.id, input.agentId, input.version, input.contentHash, toJson(input.plan), input.createdBy, input.createdAt]
      );
      return repository.getPlan(input.id);
    },
    async activatePlan(agentId, planId, at) {
      await client.execute(
        "UPDATE agent_plans SET status = 'superseded', superseded_at = ? WHERE agent_id = ? AND status = 'active' AND id <> ?",
        [at, agentId, planId]
      );
      const result = await client.execute(
        "UPDATE agent_plans SET status = 'active', activated_at = ? WHERE id = ? AND agent_id = ? AND status = 'draft'",
        [at, planId, agentId]
      );
      return result.changes > 0;
    },
    async getPlan(id) {
      return first(await client.query("SELECT * FROM agent_plans WHERE id = ?", [id]), PLAN_JSON);
    },
    async getActivePlan(agentId) {
      return first(await client.query("SELECT * FROM agent_plans WHERE agent_id = ? AND status = 'active'", [agentId]), PLAN_JSON);
    },
    async listPlans(agentId) {
      return hydrateRows(await client.query("SELECT * FROM agent_plans WHERE agent_id = ? ORDER BY version", [agentId]), PLAN_JSON);
    },

    /** Inserts a task once per (agent, kind, slot); a second scheduler cannot duplicate it. */
    async insertTask(input) {
      const result = await client.execute(
        `INSERT INTO agent_tasks (id, agent_id, plan_id, kind, slot, due_at, expires_at, status, attempts,
           claimed_at, lease_expires_at, completed_at, report_id, error_code, error_detail, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT (agent_id, kind, slot) DO NOTHING`,
        [input.id, input.agentId, input.planId, input.kind, input.slot, input.dueAt, input.expiresAt, input.status ?? "pending",
          input.status === "expired" ? input.createdAt : null, input.errorCode ?? null, input.errorDetail ?? null, input.createdBy, input.createdAt]
      );
      return result.changes > 0;
    },
    async getTask(id) {
      return first(await client.query("SELECT * FROM agent_tasks WHERE id = ?", [id]));
    },
    async listTasks({ agentId, status, limit } = {}) {
      const clauses = [];
      const params = [];
      if (agentId) { clauses.push("agent_id = ?"); params.push(agentId); }
      if (status) { clauses.push("status = ?"); params.push(status); }
      params.push(boundedLimit(limit));
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return hydrateRows(await client.query(`SELECT * FROM agent_tasks ${where} ORDER BY due_at DESC, id LIMIT ?`, params));
    },
    async claimTask({ id, agentId, at, leaseMs }) {
      const result = await client.execute(
        `UPDATE agent_tasks
         SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, attempts = attempts + 1
         WHERE id = ? AND agent_id = ? AND status = 'pending' AND due_at <= ? AND expires_at > ?`,
        [at, at + leaseMs, id, agentId, at, at]
      );
      return result.changes > 0;
    },
    async completeTask({ id, reportId, at }) {
      const result = await client.execute(
        "UPDATE agent_tasks SET status = 'completed', completed_at = ?, report_id = ? WHERE id = ? AND status = 'claimed'",
        [at, reportId, id]
      );
      return result.changes > 0;
    },
    async failTask({ id, agentId, code, detail, at }) {
      const result = await client.execute(
        `UPDATE agent_tasks SET status = 'failed', completed_at = ?, error_code = ?, error_detail = ?
         WHERE id = ? AND agent_id = ? AND status IN ('pending', 'claimed')`,
        [at, code, detail ?? null, id, agentId]
      );
      return result.changes > 0;
    },
    /** Missed and abandoned tasks become visibly expired; nothing retries silently. */
    async expireTasks(at) {
      const result = await client.execute(
        `UPDATE agent_tasks
         SET status = 'expired', completed_at = ?, error_code = CASE WHEN status = 'claimed' THEN 'lease_expired' ELSE 'not_claimed' END
         WHERE (status = 'pending' AND expires_at <= ?) OR (status = 'claimed' AND lease_expires_at <= ?)`,
        [at, at, at]
      );
      return result.changes;
    },

    async insertReceipt(input) {
      await client.execute(
        `INSERT INTO retrieval_receipts (id, agent_id, task_id, source_kind, request_json, provider, synthetic,
           content_hash, content_json, observed_at, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.agentId, input.taskId, input.sourceKind, toJson(input.request), input.provider,
          input.synthetic ? 1 : 0, input.contentHash, toJson(input.content), input.observedAt ?? null, input.fetchedAt]
      );
      return repository.getReceipt(input.id);
    },
    async getReceipt(id) {
      return bool(first(await client.query("SELECT * FROM retrieval_receipts WHERE id = ?", [id]), RECEIPT_JSON), "synthetic");
    },
    async listReceiptsForTask(taskId) {
      return hydrateRows(await client.query("SELECT * FROM retrieval_receipts WHERE task_id = ? ORDER BY fetched_at, id", [taskId]), RECEIPT_JSON)
        .map((row) => bool(row, "synthetic"));
    },

    async insertReport(input) {
      await client.execute(
        `INSERT INTO agent_reports (id, agent_id, task_id, plan_id, summary, report_json, provenance_json, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.agentId, input.taskId, input.planId, input.summary, toJson(input.report), toJson(input.provenance), input.contentHash, input.createdAt]
      );
      for (const receiptId of input.receiptIds) {
        await client.execute("INSERT INTO report_evidence (report_id, receipt_id) VALUES (?, ?)", [input.id, receiptId]);
      }
      return repository.getReport(input.id);
    },
    async getReport(id) {
      return first(await client.query("SELECT * FROM agent_reports WHERE id = ?", [id]), REPORT_JSON);
    },
    async listReports({ agentId, limit } = {}) {
      return hydrateRows(await client.query(
        "SELECT * FROM agent_reports WHERE agent_id = ? ORDER BY created_at DESC, id LIMIT ?",
        [agentId, boundedLimit(limit)]
      ), REPORT_JSON);
    },
    async listReportEvidence(reportId) {
      return (await client.query("SELECT receipt_id FROM report_evidence WHERE report_id = ? ORDER BY receipt_id", [reportId]))
        .map((row) => row.receipt_id);
    },

    async insertDecision(input) {
      await client.execute(
        `INSERT INTO agent_decisions (id, agent_id, report_id, task_id, symbol, action, score, rationale, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.agentId, input.reportId, input.taskId, input.symbol, input.action, input.score ?? null,
          input.rationale, toJson(input.evidence, []), input.createdAt]
      );
    },
    async getDecision(id) {
      return first(await client.query("SELECT * FROM agent_decisions WHERE id = ?", [id]), DECISION_JSON);
    },
    async listDecisions({ reportId, agentId, limit } = {}) {
      if (reportId) {
        return hydrateRows(await client.query("SELECT * FROM agent_decisions WHERE report_id = ? ORDER BY symbol", [reportId]), DECISION_JSON);
      }
      return hydrateRows(await client.query(
        "SELECT * FROM agent_decisions WHERE agent_id = ? ORDER BY created_at DESC, id LIMIT ?",
        [agentId, boundedLimit(limit)]
      ), DECISION_JSON);
    },

    async getIntentByKey(agentId, idempotencyKey) {
      return first(await client.query("SELECT * FROM agent_intents WHERE agent_id = ? AND idempotency_key = ?", [agentId, idempotencyKey]));
    },
    async getIntent(id) {
      return first(await client.query("SELECT * FROM agent_intents WHERE id = ?", [id]));
    },
    async insertIntent(input) {
      await client.execute(
        `INSERT INTO agent_intents (id, agent_id, decision_id, idempotency_key, request_hash, symbol, side, notional_cents, qty,
           status, client_order_id, order_id, reject_code, reject_message, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'received', ?, NULL, NULL, NULL, 0, ?, ?)
         ON CONFLICT (agent_id, idempotency_key) DO NOTHING`,
        [input.id, input.agentId, input.decisionId ?? null, input.idempotencyKey, input.requestHash, input.symbol, input.side,
          input.notionalCents ?? null, input.clientOrderId, input.createdAt, input.createdAt]
      );
      return repository.getIntentByKey(input.agentId, input.idempotencyKey);
    },
    /**
     * Compare-and-set transition: applies only while the intent is still in one of
     * `from`, so a terminal intent can never be moved back. Returns whether it applied.
     */
    async transitionIntent(id, from, changes) {
      const placeholders = from.map(() => "?").join(", ");
      const result = await client.execute(
        `UPDATE agent_intents
         SET status = ?, qty = COALESCE(?, qty), order_id = COALESCE(?, order_id),
             reject_code = ?, reject_message = ?, attempts = attempts + ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`,
        [changes.status, changes.qty ?? null, changes.orderId ?? null, changes.rejectCode ?? null,
          changes.rejectMessage ?? null, changes.attempt ? 1 : 0, changes.at, id, ...from]
      );
      return result.changes > 0;
    },
    async countLiveIntentsForDecision(decisionId, excludeId) {
      const rows = await client.query(
        "SELECT COUNT(*) AS count FROM agent_intents WHERE decision_id = ? AND id <> ? AND status IN ('received', 'submitting', 'filled')",
        [decisionId, excludeId]
      );
      return Number(rows[0]?.count ?? 0);
    },
    async countIntentsSince(agentId, since) {
      const rows = await client.query(
        "SELECT COUNT(*) AS count FROM agent_intents WHERE agent_id = ? AND created_at >= ? AND status <> 'rejected'",
        [agentId, since]
      );
      return Number(rows[0]?.count ?? 0);
    },
    async listIntentsByStatus(statuses, updatedBefore) {
      const placeholders = statuses.map(() => "?").join(", ");
      return hydrateRows(await client.query(
        `SELECT * FROM agent_intents WHERE status IN (${placeholders}) AND updated_at <= ? ORDER BY updated_at, id LIMIT 100`,
        [...statuses, updatedBefore]
      ));
    },
    async listIntents({ agentId, limit } = {}) {
      return hydrateRows(await client.query(
        "SELECT * FROM agent_intents WHERE agent_id = ? ORDER BY created_at DESC, id LIMIT ?",
        [agentId, boundedLimit(limit)]
      ));
    },

    /** Leader lease so only one supervisor process schedules tasks. */
    async acquireLease({ name, holder, at, ttlMs }) {
      await client.execute(
        `INSERT INTO swarm_leases (name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
         WHERE swarm_leases.holder = excluded.holder OR swarm_leases.expires_at <= ?`,
        [name, holder, at, at + ttlMs, at]
      );
      const rows = await client.query("SELECT holder, expires_at FROM swarm_leases WHERE name = ?", [name]);
      return rows[0]?.holder === holder;
    },
    async releaseLease({ name, holder }) {
      await client.execute("DELETE FROM swarm_leases WHERE name = ? AND holder = ?", [name, holder]);
    },
    async getLease(name) {
      return first(await client.query("SELECT * FROM swarm_leases WHERE name = ?", [name]));
    }
  };
  return Object.freeze(repository);
}
