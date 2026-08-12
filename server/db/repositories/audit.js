import { assertClient, boundedLimit, first, hydrateRows, requireFields, toJson } from "./_helpers.js";

const AUDIT_JSON_FIELDS = ["detailJson"];

export function createAuditRepository(client) {
  assertClient(client);

  const repository = {
    async append(input) {
      requireFields(input, ["id", "at", "actor", "action", "entity"], "audit entry");
      await client.execute(
        `INSERT INTO audit_log
          (id, at, actor, action, entity, entity_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.id,
          input.at,
          input.actor,
          input.action,
          input.entity,
          input.entityId ?? null,
          input.detail == null ? null : toJson(input.detail, {})
        ]
      );
      return first(await client.query("SELECT * FROM audit_log WHERE id = ?", [input.id]), AUDIT_JSON_FIELDS);
    },

    async list(options = {}) {
      const clauses = [];
      const params = [];
      for (const [option, column] of [
        ["actor", "actor"],
        ["action", "action"],
        ["entity", "entity"],
        ["entityId", "entity_id"]
      ]) {
        if (options[option]) {
          clauses.push(`${column} = ?`);
          params.push(options[option]);
        }
      }
      if (options.before !== undefined) {
        clauses.push("at < ?");
        params.push(options.before);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit));
      return hydrateRows(
        await client.query(`SELECT * FROM audit_log ${where} ORDER BY at DESC, id DESC LIMIT ?`, params),
        AUDIT_JSON_FIELDS
      );
    }
  };

  return Object.freeze(repository);
}

