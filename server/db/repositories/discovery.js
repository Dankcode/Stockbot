import { assertClient, boundedLimit, first, hydrateRows, toJson } from "./_helpers.js";

const RUN_JSON = ["paramsJson", "progressJson", "statsJson"];
const CANDIDATE_JSON = ["metricsJson", "fundamentalsJson", "scoresJson"];
const REQUEST_JSON = ["scrapersJson", "resultJson"];

export function createDiscoveryRepository(client) {
  assertClient(client);
  const repository = {
    async getReferenceList(name) {
      return first(await client.query("SELECT * FROM reference_lists WHERE name = ?", [name]), ["symbolsJson"]);
    },
    async putReferenceList({ name, source, asOf, symbols, fetchedAt }) {
      await client.execute(
        `INSERT INTO reference_lists (name, source, as_of, symbols_json, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET source = excluded.source, as_of = excluded.as_of, symbols_json = excluded.symbols_json, fetched_at = excluded.fetched_at`,
        [name, source, asOf ?? null, toJson(symbols, []), fetchedAt]
      );
    },

    async storedMarketDates(limit = 10) {
      return (await client.query("SELECT date FROM market_daily_dates ORDER BY date DESC LIMIT ?", [limit])).map((row) => row.date);
    },
    async hasMarketDate(date) {
      return (await client.query("SELECT 1 AS hit FROM market_daily_dates WHERE date = ?", [date])).length > 0;
    },
    async storeMarketDay({ date, rows, source, fetchedAt }) {
      await client.transaction(async (transaction) => {
        for (let index = 0; index < rows.length; index += 500) {
          const chunk = rows.slice(index, index + 500);
          await transaction.execute(
            `INSERT INTO market_daily (date, symbol, open, high, low, close, volume, vwap) VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
             ON CONFLICT (date, symbol) DO NOTHING`,
            chunk.flatMap((row) => [date, row.symbol, row.open ?? null, row.high ?? null, row.low ?? null, row.close, row.volume, row.vwap ?? null])
          );
        }
        await transaction.execute(
          `INSERT INTO market_daily_dates (date, rows, source, fetched_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (date) DO UPDATE SET rows = excluded.rows, source = excluded.source, fetched_at = excluded.fetched_at`,
          [date, rows.length, source, fetchedAt]
        );
      });
    },
    async marketRows(dates) {
      if (!dates.length) return [];
      const rows = await client.query(`SELECT date, symbol, close, volume FROM market_daily WHERE date IN (${dates.map(() => "?").join(", ")})`, dates);
      const byDate = new Map(dates.map((date) => [date, []]));
      for (const row of rows) byDate.get(row.date)?.push(row);
      return [...byDate.values()];
    },

    async getFundamentals(symbol, source, maxAgeMs, now) {
      const row = first(await client.query("SELECT * FROM fundamentals_cache WHERE symbol = ? AND source = ?", [symbol, source]), ["payloadJson"]);
      return row && now - row.fetchedAt <= maxAgeMs ? row.payloadJson : null;
    },
    async putFundamentals({ symbol, source, payload, fetchedAt }) {
      await client.execute(
        `INSERT INTO fundamentals_cache (symbol, source, payload_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (symbol, source) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
        [symbol, source, toJson(payload), fetchedAt]
      );
    },

    async createRun({ id, params, createdAt }) {
      await client.execute("INSERT INTO discovery_runs (id, status, params_json, created_at) VALUES (?, 'running', ?, ?)", [id, toJson(params), createdAt]);
      return repository.getRun(id);
    },
    async updateRunProgress(id, progress) {
      await client.execute("UPDATE discovery_runs SET progress_json = ? WHERE id = ? AND status = 'running'", [toJson(progress), id]);
    },
    async finishRun(id, { status, stats, error, completedAt }) {
      await client.execute(
        "UPDATE discovery_runs SET status = ?, stats_json = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'running'",
        [status, toJson(stats ?? {}), error ?? null, completedAt, id]
      );
    },
    async failAbandonedRuns(at) {
      const result = await client.execute(
        "UPDATE discovery_runs SET status = 'failed', error = 'The server restarted while this run was in progress.', completed_at = ? WHERE status = 'running'",
        [at]
      );
      return result.changes;
    },
    async getRun(id) {
      return first(await client.query("SELECT * FROM discovery_runs WHERE id = ?", [id]), RUN_JSON);
    },
    async listRuns(limit) {
      return hydrateRows(await client.query("SELECT * FROM discovery_runs ORDER BY created_at DESC LIMIT ?", [boundedLimit(limit, 20, 100)]), RUN_JSON);
    },
    async runningRun() {
      return first(await client.query("SELECT * FROM discovery_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"), RUN_JSON);
    },
    async insertCandidates(runId, candidates) {
      await client.transaction(async (transaction) => {
        for (const candidate of candidates) {
          await transaction.execute(
            `INSERT INTO discovery_candidates (run_id, symbol, name, exchange, growth_score, hold_score, metrics_json, fundamentals_json, scores_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [runId, candidate.symbol, candidate.name ?? null, candidate.exchange ?? null, candidate.scores.growth.score, candidate.scores.hold.score,
              toJson(candidate.metrics), candidate.fundamentals ? toJson(candidate.fundamentals) : null, toJson(candidate.scores)]
          );
        }
      });
    },
    async listCandidates(runId, { lens = "growth", limit = 100 } = {}) {
      const column = lens === "hold" ? "hold_score" : "growth_score";
      return hydrateRows(await client.query(
        `SELECT * FROM discovery_candidates WHERE run_id = ? ORDER BY CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END, ${column} DESC, symbol LIMIT ?`,
        [runId, boundedLimit(limit, 100, 1000)]
      ), CANDIDATE_JSON);
    },
    async latestCandidate(symbol) {
      return first(await client.query(
        `SELECT c.* FROM discovery_candidates c JOIN discovery_runs r ON r.id = c.run_id
         WHERE c.symbol = ? AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 1`,
        [symbol]
      ), CANDIDATE_JSON);
    },

    async listWatchlist() {
      return hydrateRows(await client.query("SELECT * FROM discovery_watchlist ORDER BY updated_at DESC, symbol"));
    },
    async getWatch(symbol) {
      return first(await client.query("SELECT * FROM discovery_watchlist WHERE symbol = ?", [symbol]));
    },
    async upsertWatch({ symbol, status, note, sourceRunId, at }) {
      await client.execute(
        `INSERT INTO discovery_watchlist (symbol, status, note, source_run_id, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol) DO UPDATE SET status = excluded.status,
           note = COALESCE(excluded.note, discovery_watchlist.note), updated_at = excluded.updated_at`,
        [symbol, status, note ?? null, sourceRunId ?? null, at, at]
      );
      return repository.getWatch(symbol);
    },
    async removeWatch(symbol) {
      return (await client.execute("DELETE FROM discovery_watchlist WHERE symbol = ?", [symbol])).changes > 0;
    },

    async createResearchRequest({ id, symbol, question, scrapers, createdAt }) {
      await client.execute(
        "INSERT INTO discovery_research_requests (id, symbol, status, question, scrapers_json, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
        [id, symbol, question ?? null, toJson(scrapers ?? [], []), createdAt]
      );
      return repository.getResearchRequest(id);
    },
    async getResearchRequest(id) {
      return first(await client.query("SELECT * FROM discovery_research_requests WHERE id = ?", [id]), REQUEST_JSON);
    },
    async listResearchRequests({ status, symbol, limit } = {}) {
      const clauses = [];
      const params = [];
      if (status) { clauses.push("status = ?"); params.push(status); }
      if (symbol) { clauses.push("symbol = ?"); params.push(symbol); }
      params.push(boundedLimit(limit, 50, 250));
      return hydrateRows(await client.query(
        `SELECT * FROM discovery_research_requests ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`, params
      ), REQUEST_JSON);
    },
    /** Compare-and-set transition; returns whether it applied. */
    async transitionResearch(id, from, changes) {
      const result = await client.execute(
        `UPDATE discovery_research_requests
         SET status = ?, researcher = COALESCE(?, researcher), result_json = COALESCE(?, result_json), error = COALESCE(?, error),
             claimed_at = COALESCE(?, claimed_at), completed_at = COALESCE(?, completed_at)
         WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
        [changes.status, changes.researcher ?? null, changes.result === undefined ? null : toJson(changes.result), changes.error ?? null,
          changes.claimedAt ?? null, changes.completedAt ?? null, id, ...from]
      );
      return result.changes > 0;
    }
  };
  return Object.freeze(repository);
}
