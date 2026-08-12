import {
  assertClient,
  boundedLimit,
  first,
  hydrateRows,
  requireFields,
  toJson
} from "./_helpers.js";

const SESSION_JSON_FIELDS = ["paramsJson", "symbolsJson", "fillModelJson", "riskProfileJson", "scheduleJson"];
const EVENT_JSON_FIELDS = ["detailJson"];

function sessionJson(input, key, alias, fallback) {
  if (input[key] !== undefined) {
    return toJson(input[key], fallback);
  }
  return toJson(input[alias], fallback);
}

export function createSessionsRepository(client) {
  assertClient(client);

  const repository = {
    async create(input) {
      requireFields(
        input,
        ["id", "accountId", "name", "mode", "status", "barInterval", "startingEquity"],
        "session"
      );
      if (input.symbols === undefined && input.symbolsJson === undefined) {
        throw new TypeError("session.symbols is required.");
      }
      if (input.fillModel === undefined && input.fillModelJson === undefined) {
        throw new TypeError("session.fillModel is required.");
      }

      await client.execute(
        `INSERT INTO sessions (
          id, account_id, name, mode, status, algorithm_version_id,
          params_json, symbols_json, bar_interval, window_start, window_end,
          fill_model_json, risk_profile_json, schedule_json, starting_equity, ending_equity,
          started_at, ended_at, stop_reason, error_detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.accountId,
          input.name,
          input.mode,
          input.status,
          input.algorithmVersionId ?? null,
          sessionJson(input, "params", "paramsJson", {}),
          sessionJson(input, "symbols", "symbolsJson", []),
          input.barInterval,
          input.windowStart ?? null,
          input.windowEnd ?? null,
          sessionJson(input, "fillModel", "fillModelJson", {}),
          sessionJson(input, "riskProfile", "riskProfileJson", {}),
          sessionJson(input, "schedule", "scheduleJson", {}),
          input.startingEquity,
          input.endingEquity ?? null,
          input.startedAt ?? null,
          input.endedAt ?? null,
          input.stopReason ?? null,
          input.errorDetail ?? null,
          input.createdAt ?? Date.now()
        ]
      );
      return repository.getById(input.id);
    },

    async getById(id) {
      return first(await client.query("SELECT * FROM sessions WHERE id = ?", [id]), SESSION_JSON_FIELDS);
    },

    async list(options = {}) {
      const clauses = [];
      const params = [];
      if (options.accountId) {
        clauses.push("account_id = ?");
        params.push(options.accountId);
      }
      if (options.status) {
        clauses.push("status = ?");
        params.push(options.status);
      }
      if (options.mode) {
        clauses.push("mode = ?");
        params.push(options.mode);
      }
      if (options.algorithmVersionId) {
        clauses.push("algorithm_version_id = ?");
        params.push(options.algorithmVersionId);
      }
      if (options.beforeCreatedAt !== undefined) {
        clauses.push("created_at < ?");
        params.push(options.beforeCreatedAt);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit));
      const rows = await client.query(
        `SELECT * FROM sessions ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
        params
      );
      return hydrateRows(rows, SESSION_JSON_FIELDS);
    },

    async transition(id, status, options = {}) {
      const expected = Array.isArray(options.from) ? options.from : options.from ? [options.from] : [];
      const params = [
        status,
        options.startedAt ?? null,
        options.endedAt ?? null,
        options.endingEquity ?? null,
        options.stopReason ?? null,
        options.errorDetail ?? null,
        id
      ];
      let predicate = "id = ?";
      if (expected.length) {
        predicate += ` AND status IN (${expected.map(() => "?").join(", ")})`;
        params.push(...expected);
      }
      const result = await client.execute(
        `UPDATE sessions SET
           status = ?,
           started_at = COALESCE(?, started_at),
           ended_at = COALESCE(?, ended_at),
           ending_equity = COALESCE(?, ending_equity),
           stop_reason = COALESCE(?, stop_reason),
           error_detail = COALESCE(?, error_detail)
         WHERE ${predicate}`,
        params
      );
      return result.changes > 0 ? repository.getById(id) : null;
    },

    async upsertMetrics(input) {
      requireFields(input, ["id", "sessionId", "metricsVersion"], "session metrics");
      await client.execute(
        `INSERT INTO session_metrics (
          id, session_id, computed_at, metrics_version, return_percent,
          final_equity, max_drawdown, sharpe, sortino, profit_factor,
          win_rate, trade_count, exposure_percent, avg_trade_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (session_id, metrics_version) DO UPDATE SET
          id = excluded.id,
          computed_at = excluded.computed_at,
          return_percent = excluded.return_percent,
          final_equity = excluded.final_equity,
          max_drawdown = excluded.max_drawdown,
          sharpe = excluded.sharpe,
          sortino = excluded.sortino,
          profit_factor = excluded.profit_factor,
          win_rate = excluded.win_rate,
          trade_count = excluded.trade_count,
          exposure_percent = excluded.exposure_percent,
          avg_trade_percent = excluded.avg_trade_percent`,
        [
          input.id,
          input.sessionId,
          input.computedAt ?? Date.now(),
          input.metricsVersion,
          input.returnPercent ?? null,
          input.finalEquity ?? null,
          input.maxDrawdown ?? null,
          input.sharpe ?? null,
          input.sortino ?? null,
          input.profitFactor ?? null,
          input.winRate ?? null,
          input.tradeCount ?? 0,
          input.exposurePercent ?? null,
          input.avgTradePercent ?? null
        ]
      );
      return repository.getMetrics(input.sessionId, input.metricsVersion);
    },

    async getMetrics(sessionId, metricsVersion) {
      const rows = metricsVersion
        ? await client.query(
            "SELECT * FROM session_metrics WHERE session_id = ? AND metrics_version = ?",
            [sessionId, metricsVersion]
          )
        : await client.query(
            "SELECT * FROM session_metrics WHERE session_id = ? ORDER BY computed_at DESC LIMIT 1",
            [sessionId]
          );
      return first(rows);
    },

    async addEquitySnapshot(input) {
      requireFields(input, ["sessionId", "at", "equity", "cash", "positionValue"], "equity snapshot");
      await client.execute(
        `INSERT INTO equity_snapshots
          (session_id, at, equity, cash, position_value, drawdown_percent)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, at) DO UPDATE SET
           equity = excluded.equity,
           cash = excluded.cash,
           position_value = excluded.position_value,
           drawdown_percent = excluded.drawdown_percent`,
        [input.sessionId, input.at, input.equity, input.cash, input.positionValue, input.drawdownPercent ?? 0]
      );
      return first(
        await client.query("SELECT * FROM equity_snapshots WHERE session_id = ? AND at = ?", [
          input.sessionId,
          input.at
        ])
      );
    },

    async getEquity(sessionId, options = {}) {
      const clauses = ["session_id = ?"];
      const params = [sessionId];
      if (options.after !== undefined) {
        clauses.push("at >= ?");
        params.push(options.after);
      }
      if (options.before !== undefined) {
        clauses.push("at <= ?");
        params.push(options.before);
      }
      params.push(boundedLimit(options.limit, 1_000, 50_000));
      return hydrateRows(
        await client.query(
          `SELECT * FROM equity_snapshots WHERE ${clauses.join(" AND ")} ORDER BY at LIMIT ?`,
          params
        )
      );
    },

    async getAccountEquity(accountId, options = {}) {
      const rows = await client.query(
        `SELECT equity_snapshots.at, equity_snapshots.equity
         FROM equity_snapshots
         JOIN sessions ON sessions.id = equity_snapshots.session_id
         WHERE sessions.account_id = ?
         ORDER BY equity_snapshots.at DESC
         LIMIT ?`,
        [accountId, boundedLimit(options.limit, 500, 5_000)]
      );
      const byTime = new Map();
      for (const row of hydrateRows(rows)) if (!byTime.has(row.at)) byTime.set(row.at, row);
      return [...byTime.values()].sort((left, right) => Number(left.at) - Number(right.at));
    },

    async addEvent(input) {
      requireFields(input, ["id", "sessionId", "at", "type"], "session event");
      await client.execute(
        `INSERT INTO session_events
          (id, session_id, at, type, from_status, to_status, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.id, input.sessionId, input.at, input.type, input.fromStatus ?? null, input.toStatus ?? null, toJson(input.detail, {})]
      );
      return first(await client.query("SELECT * FROM session_events WHERE id = ?", [input.id]), EVENT_JSON_FIELDS);
    },

    async listEvents(sessionId, options = {}) {
      const params = [sessionId];
      let before = "";
      if (options.before !== undefined) { before = "AND at < ?"; params.push(options.before); }
      params.push(boundedLimit(options.limit, 100, 1_000));
      return hydrateRows(
        await client.query(`SELECT * FROM session_events WHERE session_id = ? ${before} ORDER BY at DESC, id DESC LIMIT ?`, params),
        EVENT_JSON_FIELDS
      );
    }
  };

  return Object.freeze(repository);
}
