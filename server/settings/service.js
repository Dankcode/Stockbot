import crypto from "node:crypto";
import { AppError } from "../http/errors.js";

const GROUPS = Object.freeze([
  {
    id: "providers",
    label: "Data providers",
    fields: [
      { key: "ALPACA_API_KEY", label: "Alpaca API key", secret: true },
      { key: "ALPACA_API_SECRET", label: "Alpaca API secret", secret: true },
      { key: "ALPACA_DATA_BASE_URL", label: "Alpaca market data URL" },
      { key: "ALPACA_STOCK_FEED", label: "Alpaca stock feed" },
      { key: "POLYGON_API_KEY", label: "Polygon API key", secret: true },
      { key: "FINNHUB_API_KEY", label: "Finnhub API key", secret: true }
    ]
  },
  {
    id: "runtime",
    label: "Runtime",
    fields: [
      { key: "QUOTE_FRESHNESS_MS", label: "Maximum quote age (ms)", readOnly: true },
      { key: "ENGINE_TIMEOUT_MS", label: "Engine timeout (ms)", readOnly: true },
      { key: "STOCKBOT_MODE", label: "Account mode", readOnly: true }
    ]
  }
]);

const FIELDS = new Map(GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field])));

function cipherKey(secret) {
  return secret ? crypto.createHash("sha256").update(secret).digest() : null;
}

function encrypt(value, secret) {
  const key = cipherKey(secret);
  if (!key) throw new AppError("SETTINGS_KEY_REQUIRED", "STOCKBOT_SETTINGS_KEY is required before secrets can be stored.", 409);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decrypt(value, secret) {
  if (!value?.startsWith("enc:v1:")) return value;
  const key = cipherKey(secret);
  if (!key) throw new AppError("SETTINGS_KEY_REQUIRED", "Stored secrets cannot be opened without STOCKBOT_SETTINGS_KEY.", 503);
  const [, , iv, tag, body] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export function createSettingsService(repository, config, onProviderChange = () => {}) {
  function configuredValue(key) {
    const values = {
      ALPACA_API_KEY: config.alpaca.key,
      ALPACA_API_SECRET: config.alpaca.secret,
      ALPACA_DATA_BASE_URL: config.alpaca.dataBaseUrl,
      ALPACA_STOCK_FEED: config.alpaca.stockFeed,
      POLYGON_API_KEY: config.polygon.key,
      FINNHUB_API_KEY: config.finnhub.key,
      QUOTE_FRESHNESS_MS: config.quoteFreshnessMs,
      ENGINE_TIMEOUT_MS: config.engineTimeoutMs,
      STOCKBOT_MODE: config.mode
    };
    return values[key] ?? "";
  }

  async function values() {
    const rows = await repository.list();
    return new Map(rows.map((row) => [row.key, row]));
  }

  async function getInternal(key) {
    const row = await repository.get(key);
    if (!row) return process.env[key] || "";
    return row.isSecret ? decrypt(row.value, config.settingsEncryptionKey) : row.value || "";
  }

  async function publicPayload() {
    const stored = await values();
    return {
      encryptionReady: Boolean(config.settingsEncryptionKey),
      groups: GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        fields: group.fields.map((field) => {
          const row = stored.get(field.key);
          const environmentValue = process.env[field.key] || configuredValue(field.key);
          const hasValue = Boolean(row?.value || environmentValue);
          return {
            key: field.key,
            label: field.label,
            secret: Boolean(field.secret),
            readOnly: Boolean(field.readOnly),
            hasValue,
            value: field.secret ? "" : (row?.value ?? environmentValue)
          };
        })
      }))
    };
  }

  async function update(incoming) {
    const updates = [];
    for (const [key, raw] of Object.entries(incoming || {})) {
      const field = FIELDS.get(key);
      if (!field || field.readOnly) continue;
      const value = String(raw ?? "").trim();
      if (field.secret && value === "") continue;
      updates.push({ key, value: field.secret ? encrypt(value, config.settingsEncryptionKey) : value, isSecret: Boolean(field.secret) });
    }
    if (updates.length) await repository.setMany(updates);
    await applyToRuntime();
    onProviderChange();
    return publicPayload();
  }

  async function applyToRuntime() {
    const mapping = {
      ALPACA_API_KEY: [config.alpaca, "key"],
      ALPACA_API_SECRET: [config.alpaca, "secret"],
      ALPACA_DATA_BASE_URL: [config.alpaca, "dataBaseUrl"],
      ALPACA_STOCK_FEED: [config.alpaca, "stockFeed"],
      POLYGON_API_KEY: [config.polygon, "key"],
      FINNHUB_API_KEY: [config.finnhub, "key"]
    };
    for (const [key, [target, property]] of Object.entries(mapping)) {
      const value = await getInternal(key);
      if (value) target[property] = value;
    }
  }

  return { publicPayload, update, getInternal, applyToRuntime };
}
