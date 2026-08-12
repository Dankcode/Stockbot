import {
  assertClient,
  booleanInteger,
  boundedLimit,
  first,
  hydrateRows,
  requireFields,
  toJson
} from "./_helpers.js";

const VERSION_JSON_FIELDS = ["paramsJson"];
const BACKTEST_JSON_FIELDS = ["resultJson"];

export function createAlgorithmsRepository(client) {
  assertClient(client);

  const repository = {
    async create(input) {
      requireFields(input, ["id", "name", "sourcePath"], "algorithm");
      await client.execute(
        `INSERT INTO algorithms
          (id, name, author, description, source_path, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.name,
          input.author ?? null,
          input.description ?? null,
          input.sourcePath,
          booleanInteger(input.enabled ?? true),
          input.createdAt ?? Date.now()
        ]
      );
      return repository.getById(input.id);
    },

    async getById(id) {
      const algorithm = first(await client.query("SELECT * FROM algorithms WHERE id = ?", [id]));
      return algorithm ? { ...algorithm, enabled: Boolean(algorithm.enabled) } : null;
    },

    async list(options = {}) {
      const limit = boundedLimit(options.limit, 100, 500);
      const rows = options.enabledOnly
        ? await client.query("SELECT * FROM algorithms WHERE enabled = 1 ORDER BY name, id LIMIT ?", [limit])
        : await client.query("SELECT * FROM algorithms ORDER BY name, id LIMIT ?", [limit]);
      return hydrateRows(rows).map((algorithm) => ({ ...algorithm, enabled: Boolean(algorithm.enabled) }));
    },

    async update(id, changes = {}) {
      const result = await client.execute(
        `UPDATE algorithms SET
          name = COALESCE(?, name),
          author = COALESCE(?, author),
          description = COALESCE(?, description),
          source_path = COALESCE(?, source_path),
          enabled = COALESCE(?, enabled)
         WHERE id = ?`,
        [
          changes.name ?? null,
          changes.author ?? null,
          changes.description ?? null,
          changes.sourcePath ?? null,
          changes.enabled === undefined ? null : booleanInteger(changes.enabled),
          id
        ]
      );
      return result.changes > 0 ? repository.getById(id) : null;
    },

    async addVersion(input) {
      requireFields(input, ["id", "algorithmId", "sourceHash", "sourceCode"], "algorithm version");
      await client.execute(
        `INSERT INTO algorithm_versions
          (id, algorithm_id, source_hash, source_code, params_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (algorithm_id, source_hash) DO NOTHING`,
        [
          input.id,
          input.algorithmId,
          input.sourceHash,
          input.sourceCode,
          toJson(input.params, {}),
          input.createdAt ?? Date.now()
        ]
      );
      return first(
        await client.query(
          "SELECT * FROM algorithm_versions WHERE algorithm_id = ? AND source_hash = ?",
          [input.algorithmId, input.sourceHash]
        ),
        VERSION_JSON_FIELDS
      );
    },

    async getVersion(id) {
      return first(await client.query("SELECT * FROM algorithm_versions WHERE id = ?", [id]), VERSION_JSON_FIELDS);
    },

    async listVersions(algorithmId, options = {}) {
      return hydrateRows(
        await client.query(
          `SELECT * FROM algorithm_versions
           WHERE algorithm_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          [algorithmId, boundedLimit(options.limit, 50, 500)]
        ),
        VERSION_JSON_FIELDS
      );
    },

    async getLatestVersion(algorithmId) {
      return first(
        await client.query(
          `SELECT * FROM algorithm_versions
           WHERE algorithm_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [algorithmId]
        ),
        VERSION_JSON_FIELDS
      );
    },

    async findBacktest(input) {
      requireFields(
        input,
        [
          "algorithmVersionId",
          "symbol",
          "barInterval",
          "windowStart",
          "windowEnd",
          "barsHash",
          "paramsHash",
          "fillModelHash"
        ],
        "backtest key"
      );
      return first(
        await client.query(
          `SELECT * FROM backtest_runs WHERE
            algorithm_version_id = ? AND symbol = ? AND bar_interval = ? AND
            window_start = ? AND window_end = ? AND bars_hash = ? AND
            params_hash = ? AND fill_model_hash = ?`,
          [
            input.algorithmVersionId,
            input.symbol,
            input.barInterval,
            input.windowStart,
            input.windowEnd,
            input.barsHash,
            input.paramsHash,
            input.fillModelHash
          ]
        ),
        BACKTEST_JSON_FIELDS
      );
    },

    async putBacktest(input) {
      requireFields(input, ["id", "result"], "backtest run");
      requireFields(
        input,
        [
          "algorithmVersionId",
          "symbol",
          "barInterval",
          "windowStart",
          "windowEnd",
          "barsHash",
          "paramsHash",
          "fillModelHash"
        ],
        "backtest run"
      );
      await client.execute(
        `INSERT INTO backtest_runs (
          id, algorithm_version_id, symbol, bar_interval, window_start, window_end,
          bars_hash, params_hash, fill_model_hash, result_json, computed_at, compute_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (
          algorithm_version_id, symbol, bar_interval, window_start, window_end,
          bars_hash, params_hash, fill_model_hash
        ) DO UPDATE SET
          id = excluded.id,
          result_json = excluded.result_json,
          computed_at = excluded.computed_at,
          compute_ms = excluded.compute_ms`,
        [
          input.id,
          input.algorithmVersionId,
          input.symbol,
          input.barInterval,
          input.windowStart,
          input.windowEnd,
          input.barsHash,
          input.paramsHash,
          input.fillModelHash,
          toJson(input.result, {}),
          input.computedAt ?? Date.now(),
          input.computeMs ?? null
        ]
      );
      return repository.findBacktest(input);
    }
  };

  return Object.freeze(repository);
}

