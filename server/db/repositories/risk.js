import {
  assertClient,
  booleanInteger,
  boundedLimit,
  first,
  hydrateRows,
  requireFields,
  toJson
} from "./_helpers.js";

const PROFILE_JSON_FIELDS = ["rulesJson"];
const EVENT_JSON_FIELDS = ["detailJson"];

function normalizeProfile(profile) {
  return profile ? { ...profile, isDefault: Boolean(profile.isDefault) } : null;
}

export function createRiskRepository(client) {
  assertClient(client);

  const repository = {
    async getProfile(id) {
      return normalizeProfile(
        first(await client.query("SELECT * FROM risk_profiles WHERE id = ?", [id]), PROFILE_JSON_FIELDS)
      );
    },

    async listProfiles(accountId) {
      return hydrateRows(
        await client.query(
          "SELECT * FROM risk_profiles WHERE account_id = ? ORDER BY is_default DESC, name, id",
          [accountId]
        ),
        PROFILE_JSON_FIELDS
      ).map(normalizeProfile);
    },

    async upsertProfile(input) {
      requireFields(input, ["id", "accountId", "name", "rules"], "risk profile");
      return client.transaction(async (transaction) => {
        if (input.isDefault) {
          await transaction.execute("UPDATE risk_profiles SET is_default = 0 WHERE account_id = ?", [input.accountId]);
        }
        await transaction.execute(
          `INSERT INTO risk_profiles
            (id, account_id, name, rules_json, is_default, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             account_id = excluded.account_id,
             name = excluded.name,
             rules_json = excluded.rules_json,
             is_default = excluded.is_default,
             updated_at = excluded.updated_at`,
          [
            input.id,
            input.accountId,
            input.name,
            toJson(input.rules, {}),
            booleanInteger(input.isDefault),
            input.updatedAt ?? Date.now()
          ]
        );
        return normalizeProfile(
          first(await transaction.query("SELECT * FROM risk_profiles WHERE id = ?", [input.id]), PROFILE_JSON_FIELDS)
        );
      });
    },

    async addEvent(input) {
      requireFields(
        input,
        ["id", "accountId", "at", "ruleId", "severity", "actionTaken", "detail"],
        "risk event"
      );
      await client.execute(
        `INSERT INTO risk_events
          (id, session_id, account_id, at, rule_id, severity, action_taken, detail_json, order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.sessionId ?? null,
          input.accountId,
          input.at,
          input.ruleId,
          input.severity,
          input.actionTaken,
          toJson(input.detail, {}),
          input.orderId ?? null
        ]
      );
      return first(await client.query("SELECT * FROM risk_events WHERE id = ?", [input.id]), EVENT_JSON_FIELDS);
    },

    async listEvents(options = {}) {
      const clauses = [];
      const params = [];
      for (const [option, column] of [
        ["accountId", "account_id"],
        ["sessionId", "session_id"],
        ["severity", "severity"],
        ["ruleId", "rule_id"]
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
        await client.query(`SELECT * FROM risk_events ${where} ORDER BY at DESC, id DESC LIMIT ?`, params),
        EVENT_JSON_FIELDS
      );
    }
  };

  return Object.freeze(repository);
}

