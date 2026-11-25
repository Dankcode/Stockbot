import { assertClient, boundedLimit, first, hydrateRows, toJson } from "./_helpers.js";

const EXPERIMENT_JSON = ["configJson"];
const ARM_JSON = ["configJson"];
const SNAPSHOT_JSON = ["positionsJson"];
const REVIEW_JSON = ["verdictsJson", "lessonsJson"];
const JOB_JSON = ["detailJson"];

/** SQL for swarm experiments: arms, daily equity, benchmark closes, reviews and job runs. */
export function createSwarmExperimentsRepository(client) {
  assertClient(client);
  const repository = {
    async insertExperiment(input) {
      await client.execute(
        `INSERT INTO swarm_experiments (id, name, status, start_date, config_json, created_at, stopped_at)
         VALUES (?, ?, 'active', ?, ?, ?, NULL)`,
        [input.id, input.name, input.startDate, toJson(input.config), input.createdAt]
      );
      return repository.getExperiment(input.id);
    },
    async getExperiment(id) {
      return first(await client.query("SELECT * FROM swarm_experiments WHERE id = ?", [id]), EXPERIMENT_JSON);
    },
    async getExperimentByName(name) {
      return first(await client.query("SELECT * FROM swarm_experiments WHERE name = ?", [name]), EXPERIMENT_JSON);
    },
    async listExperiments({ status } = {}) {
      const rows = status
        ? await client.query("SELECT * FROM swarm_experiments WHERE status = ? ORDER BY created_at, id", [status])
        : await client.query("SELECT * FROM swarm_experiments ORDER BY created_at, id");
      return hydrateRows(rows, EXPERIMENT_JSON);
    },
    async stopExperiment(id, at) {
      const result = await client.execute("UPDATE swarm_experiments SET status = 'stopped', stopped_at = ? WHERE id = ? AND status = 'active'", [at, id]);
      return result.changes > 0;
    },

    async insertArm(input) {
      await client.execute(
        `INSERT INTO swarm_arms (id, experiment_id, label, kind, agent_id, account_id, status, start_date, config_json,
           created_by, source_review_id, created_at, retired_at, retire_reason)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, NULL)`,
        [input.id, input.experimentId, input.label, input.kind, input.agentId ?? null, input.accountId, input.startDate,
          toJson(input.config), input.createdBy, input.sourceReviewId ?? null, input.createdAt]
      );
      return repository.getArm(input.id);
    },
    async getArm(id) {
      return first(await client.query("SELECT * FROM swarm_arms WHERE id = ?", [id]), ARM_JSON);
    },
    async getArmByAgent(agentId) {
      return first(await client.query("SELECT * FROM swarm_arms WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1", [agentId]), ARM_JSON);
    },
    async listArms(experimentId) {
      return hydrateRows(await client.query("SELECT * FROM swarm_arms WHERE experiment_id = ? ORDER BY CASE WHEN kind = 'control' THEN 1 ELSE 0 END, created_at, label", [experimentId]), ARM_JSON);
    },
    async countArms() {
      const rows = await client.query("SELECT COUNT(*) AS count FROM swarm_arms");
      return Number(rows[0]?.count ?? 0);
    },
    async retireArm(id, { reason, at }) {
      const result = await client.execute(
        "UPDATE swarm_arms SET status = 'retired', retired_at = ?, retire_reason = ? WHERE id = ? AND status = 'active'",
        [at, reason, id]
      );
      return result.changes > 0;
    },

    /** One snapshot per arm per trading date; a second write for the same date is ignored. */
    async putSnapshot(input) {
      const result = await client.execute(
        `INSERT INTO swarm_equity_snapshots (arm_id, date, equity, cash, positions_json, taken_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (arm_id, date) DO NOTHING`,
        [input.armId, input.date, input.equity, input.cash, toJson(input.positions, []), input.takenAt]
      );
      return result.changes > 0;
    },
    async listSnapshots(armId) {
      return hydrateRows(await client.query("SELECT * FROM swarm_equity_snapshots WHERE arm_id = ? ORDER BY date", [armId]), SNAPSHOT_JSON)
        .map((row) => ({ ...row, equity: Number(row.equity), cash: Number(row.cash) }));
    },
    async putBenchmarkClose(input) {
      await client.execute(
        `INSERT INTO swarm_benchmark_closes (symbol, date, close, source, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (symbol, date) DO NOTHING`,
        [input.symbol, input.date, input.close, input.source, input.fetchedAt]
      );
    },
    async listBenchmarkCloses(symbol, fromDate = "0000-00-00") {
      return hydrateRows(await client.query("SELECT * FROM swarm_benchmark_closes WHERE symbol = ? AND date >= ? ORDER BY date", [symbol, fromDate]))
        .map((row) => ({ ...row, close: Number(row.close) }));
    },

    async insertReview(input) {
      const result = await client.execute(
        `INSERT INTO swarm_reviews (id, experiment_id, as_of_date, trading_days, verdicts_json, lessons_json, lessons_md, created_arm_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (experiment_id, as_of_date) DO NOTHING`,
        [input.id, input.experimentId, input.asOfDate, input.tradingDays, toJson(input.verdicts, []), toJson(input.lessons),
          input.lessonsMd, input.createdArmId ?? null, input.createdAt]
      );
      return result.changes > 0;
    },
    async setReviewArm(id, armId) {
      await client.execute("UPDATE swarm_reviews SET created_arm_id = ? WHERE id = ?", [armId, id]);
    },
    async setReviewMarkdown(id, markdown) {
      await client.execute("UPDATE swarm_reviews SET lessons_md = ? WHERE id = ?", [markdown, id]);
    },
    async listReviews(experimentId, limit) {
      return hydrateRows(await client.query(
        "SELECT * FROM swarm_reviews WHERE experiment_id = ? ORDER BY as_of_date DESC LIMIT ?",
        [experimentId, boundedLimit(limit, 20, 200)]
      ), REVIEW_JSON);
    },

    /** Claims a job slot exactly once across processes; false when it already ran (or is running). */
    async claimJob({ job, slot, at }) {
      const result = await client.execute(
        `INSERT INTO swarm_job_runs (job, slot, status, detail_json, started_at, finished_at)
         VALUES (?, ?, 'running', '{}', ?, NULL) ON CONFLICT (job, slot) DO NOTHING`,
        [job, slot, at]
      );
      return result.changes > 0;
    },
    async finishJob({ job, slot, status, detail, at }) {
      await client.execute(
        "UPDATE swarm_job_runs SET status = ?, detail_json = ?, finished_at = ? WHERE job = ? AND slot = ?",
        [status, toJson(detail), at, job, slot]
      );
    },
    async listJobRuns(limit) {
      return hydrateRows(await client.query("SELECT * FROM swarm_job_runs ORDER BY started_at DESC LIMIT ?", [boundedLimit(limit, 30, 200)]), JOB_JSON);
    },

    /** Every fill in a sleeve, oldest first, with the order's symbol and side (prices in cents, qty in micro-shares). */
    async accountFills(accountId) {
      const rows = await client.query(
        `SELECT orders.id AS order_id, orders.client_order_id, orders.symbol, orders.side, fills.qty, fills.price, fills.commission, fills.filled_at
         FROM fills JOIN orders ON orders.id = fills.order_id
         WHERE orders.account_id = ? ORDER BY fills.filled_at, fills.id`,
        [accountId]
      );
      return hydrateRows(rows).map((row) => ({ ...row, qty: Number(row.qty), price: Number(row.price), commission: Number(row.commission), filledAt: Number(row.filledAt) }));
    },
    /** Filled agent intents with the features recorded when they were sent. */
    async filledIntents(agentId) {
      return hydrateRows(await client.query(
        `SELECT agent_intents.id, agent_intents.order_id, agent_intents.symbol, agent_intents.side, agent_intents.entry_features_json,
                agent_decisions.rationale, agent_decisions.score
         FROM agent_intents LEFT JOIN agent_decisions ON agent_decisions.id = agent_intents.decision_id
         WHERE agent_intents.agent_id = ? AND agent_intents.status = 'filled' ORDER BY agent_intents.created_at`,
        [agentId]
      ), ["entryFeaturesJson"]);
    }
  };
  return repository;
}
