import {
  assertClient,
  booleanInteger,
  boundedLimit,
  first,
  hydrateRows,
  requireFields,
  toJson
} from "./_helpers.js";

const ALERT_JSON_FIELDS = ["conditionJson", "channelConfigJson"];
const DELIVERY_JSON_FIELDS = ["payloadJson"];

function normalizeAlert(alert) {
  return alert ? { ...alert, enabled: Boolean(alert.enabled) } : null;
}

export function createAlertsRepository(client) {
  assertClient(client);

  const repository = {
    async create(input) {
      requireFields(
        input,
        ["id", "accountId", "name", "triggerType", "condition", "channel"],
        "alert"
      );
      await client.execute(
        `INSERT INTO alerts (
          id, account_id, name, trigger_type, condition_json, channel,
          channel_config_json, enabled, cooldown_ms, last_fired_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.accountId,
          input.name,
          input.triggerType,
          toJson(input.condition, {}),
          input.channel,
          input.channelConfig == null ? null : toJson(input.channelConfig, {}),
          booleanInteger(input.enabled ?? true),
          input.cooldownMs ?? 0,
          input.lastFiredAt ?? null,
          input.createdAt ?? Date.now()
        ]
      );
      return repository.getById(input.id);
    },

    async getById(id) {
      return normalizeAlert(first(await client.query("SELECT * FROM alerts WHERE id = ?", [id]), ALERT_JSON_FIELDS));
    },

    async list(options = {}) {
      const clauses = [];
      const params = [];
      if (options.accountId) {
        clauses.push("account_id = ?");
        params.push(options.accountId);
      }
      if (options.enabledOnly) {
        clauses.push("enabled = 1");
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit, 100, 500));
      return hydrateRows(
        await client.query(`SELECT * FROM alerts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, params),
        ALERT_JSON_FIELDS
      ).map(normalizeAlert);
    },

    async listEnabled(options = {}) {
      return repository.list({ ...options, enabledOnly: true });
    },

    async update(id, changes = {}) {
      const result = await client.execute(
        `UPDATE alerts SET
          name = COALESCE(?, name),
          condition_json = COALESCE(?, condition_json),
          channel = COALESCE(?, channel),
          channel_config_json = COALESCE(?, channel_config_json),
          enabled = COALESCE(?, enabled),
          cooldown_ms = COALESCE(?, cooldown_ms),
          last_fired_at = COALESCE(?, last_fired_at)
         WHERE id = ?`,
        [
          changes.name ?? null,
          changes.condition === undefined ? null : toJson(changes.condition, {}),
          changes.channel ?? null,
          changes.channelConfig === undefined ? null : toJson(changes.channelConfig, {}),
          changes.enabled === undefined ? null : booleanInteger(changes.enabled),
          changes.cooldownMs ?? null,
          changes.lastFiredAt ?? null,
          id
        ]
      );
      return result.changes > 0 ? repository.getById(id) : null;
    },

    async addDelivery(input) {
      requireFields(input, ["id", "alertId", "at", "status", "payload"], "alert delivery");
      await client.execute(
        `INSERT INTO alert_deliveries
          (id, alert_id, session_id, at, status, payload_json, error_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.id,
          input.alertId,
          input.sessionId ?? null,
          input.at,
          input.status,
          toJson(input.payload, {}),
          input.errorDetail ?? null
        ]
      );
      return first(
        await client.query("SELECT * FROM alert_deliveries WHERE id = ?", [input.id]),
        DELIVERY_JSON_FIELDS
      );
    },

    async createDelivery(input) {
      return repository.addDelivery(input);
    },

    async updateDelivery(id, status, errorDetail = null) {
      const result = await client.execute(
        "UPDATE alert_deliveries SET status = ?, error_detail = ? WHERE id = ?",
        [status, errorDetail, id]
      );
      return result.changes > 0
        ? first(await client.query("SELECT * FROM alert_deliveries WHERE id = ?", [id]), DELIVERY_JSON_FIELDS)
        : null;
    },

    async markDeliveryFailed(id, errorDetail) {
      return repository.updateDelivery(id, "failed", errorDetail);
    },

    async acknowledgeDelivery(id, readAt = Date.now()) {
      const result = await client.execute(
        "UPDATE alert_deliveries SET read_at = COALESCE(read_at, ?) WHERE id = ?",
        [readAt, id]
      );
      return result.changes > 0
        ? first(await client.query("SELECT * FROM alert_deliveries WHERE id = ?", [id]), DELIVERY_JSON_FIELDS)
        : null;
    },

    async unreadCount(accountId) {
      const rows = await client.query(
        `SELECT COUNT(*) AS count FROM alert_deliveries
         JOIN alerts ON alerts.id = alert_deliveries.alert_id
         WHERE alerts.account_id = ? AND alert_deliveries.read_at IS NULL
           AND alert_deliveries.status = 'sent'`,
        [accountId]
      );
      return Number(rows[0]?.count ?? 0);
    },

    async markFired(id, at = Date.now()) {
      return repository.update(id, { lastFiredAt: at });
    },

    async claimFiring(id, at, cooldownMs = 0) {
      const result = await client.execute(
        `UPDATE alerts SET last_fired_at = ?
         WHERE id = ? AND enabled = 1
           AND (last_fired_at IS NULL OR last_fired_at <= ?)`,
        [at, id, at - Math.max(0, Number(cooldownMs) || 0)]
      );
      return result.changes === 1;
    },

    async restoreFiring(id, claimedAt, previousAt = null) {
      const result = await client.execute(
        "UPDATE alerts SET last_fired_at = ? WHERE id = ? AND last_fired_at = ?",
        [previousAt, id, claimedAt]
      );
      return result.changes === 1;
    },

    async listDeliveries(options = {}) {
      const clauses = [];
      const params = [];
      if (options.alertId) {
        clauses.push("alert_id = ?");
        params.push(options.alertId);
      }
      if (options.sessionId) {
        clauses.push("session_id = ?");
        params.push(options.sessionId);
      }
      if (options.since !== undefined) {
        clauses.push("at >= ?");
        params.push(options.since);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit));
      return hydrateRows(
        await client.query(
          `SELECT * FROM alert_deliveries ${where} ORDER BY at DESC, id DESC LIMIT ?`,
          params
        ),
        DELIVERY_JSON_FIELDS
      );
    },

    async feed(accountId, options = {}) {
      const params = [accountId];
      let sinceClause = "";
      if (options.since !== undefined) {
        sinceClause = "AND alert_deliveries.at >= ?";
        params.push(options.since);
      }
      params.push(boundedLimit(options.limit));
      return hydrateRows(
        await client.query(
          `SELECT
             alert_deliveries.*,
             alerts.name AS alert_name,
             alerts.trigger_type,
             alerts.channel
           FROM alert_deliveries
           JOIN alerts ON alerts.id = alert_deliveries.alert_id
           WHERE alerts.account_id = ? ${sinceClause}
           ORDER BY alert_deliveries.at DESC, alert_deliveries.id DESC LIMIT ?`,
          params
        ),
        DELIVERY_JSON_FIELDS
      );
    }
  };

  return Object.freeze(repository);
}
