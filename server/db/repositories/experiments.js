import { assertClient, boundedLimit, first, hydrateRows, requireFields, toJson } from "./_helpers.js";

const JSON_FIELDS = ["fillModelJson", "planJson", "selectionJson"];

/** Durable experiment cohorts. Sessions remain the execution unit; this table only owns their shared provenance. */
export function createExperimentsRepository(client) {
  assertClient(client);

  const repository = {
    async create(input) {
      requireFields(input, ["id", "name", "symbol", "barInterval", "fillModel", "plan"], "experiment");
      await client.execute(
        `INSERT INTO experiments (
          id, name, symbol, bar_interval, window_start, window_end,
          fill_model_json, plan_json, selection_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.name,
          input.symbol,
          input.barInterval,
          input.windowStart ?? null,
          input.windowEnd ?? null,
          toJson(input.fillModel, {}),
          toJson(input.plan, {}),
          input.selection == null ? null : toJson(input.selection, {}),
          input.createdAt ?? Date.now()
        ]
      );
      return repository.getById(input.id);
    },

    async getById(id) {
      return first(await client.query("SELECT * FROM experiments WHERE id = ?", [id]), JSON_FIELDS);
    },

    async list(options = {}) {
      const clauses = [];
      const params = [];
      if (options.symbol) {
        clauses.push("symbol = ?");
        params.push(options.symbol);
      }
      if (options.beforeCreatedAt !== undefined) {
        clauses.push("created_at < ?");
        params.push(options.beforeCreatedAt);
      }
      params.push(boundedLimit(options.limit));
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return hydrateRows(
        await client.query(`SELECT * FROM experiments ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, params),
        JSON_FIELDS
      );
    },

    async delete(id) {
      await client.execute("DELETE FROM experiments WHERE id = ?", [id]);
    }
  };

  return Object.freeze(repository);
}
