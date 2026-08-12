import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function number(name, fallback, { min = 0, max = Number.MAX_VALUE } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false.`);
}

function secret(name) {
  const value = process.env[name] || "";
  if (value && value.length < 32) {
    throw new Error(`${name} must be at least 32 characters when configured.`);
  }
  return value;
}

export function loadConfig() {
  const host = process.env.HOST || "127.0.0.1";
  const allowRemote = bool("STOCKBOT_ALLOW_REMOTE", false);
  const apiToken = secret("STOCKBOT_API_TOKEN");
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !allowRemote) {
    throw new Error("HOST must be loopback unless STOCKBOT_ALLOW_REMOTE=true is explicitly set.");
  }
  if (allowRemote && !apiToken) {
    throw new Error("STOCKBOT_API_TOKEN is required whenever remote binding is enabled.");
  }

  return Object.freeze({
    workspaceRoot,
    host,
    port: integer("PORT", 4000, { min: 1, max: 65535 }),
    databaseUrl: process.env.DATABASE_URL || `file:${path.join(workspaceRoot, "data/stockbot.db")}`,
    apiToken,
    mode: process.env.STOCKBOT_MODE || "local-paper",
    engineWorkers: integer("ENGINE_WORKERS", Math.max(1, Math.min(4, Number(process.env.UV_THREADPOOL_SIZE) || 2)), { min: 1, max: 16 }),
    engineTimeoutMs: integer("ENGINE_TIMEOUT_MS", 10_000, { min: 100, max: 120_000 }),
    quoteCacheMs: integer("QUOTE_CACHE_MS", 4_000, { min: 0, max: 60_000 }),
    barsCacheIntradayMs: integer("BARS_CACHE_INTRADAY_MS", 60_000, { min: 0 }),
    barsCacheLongMs: integer("BARS_CACHE_LONG_MS", 300_000, { min: 0 }),
    quoteFreshnessMs: integer("QUOTE_FRESHNESS_MS", 5_000, { min: 500, max: 300_000 }),
    priceSanityPercent: number("PRICE_SANITY_PERCENT", 10, { min: 0.1, max: 100 }),
    settleDelayMs: integer("BAR_SETTLE_DELAY_MS", 2_000, { min: 0, max: 60_000 }),
    restartRunningSessions: bool("RESTART_RUNNING_SESSIONS", false),
    settingsEncryptionKey: secret("STOCKBOT_SETTINGS_KEY"),
    alpaca: {
      key: process.env.ALPACA_API_KEY || "",
      secret: process.env.ALPACA_API_SECRET || "",
      paperBaseUrl: process.env.ALPACA_PAPER_BASE_URL || "https://paper-api.alpaca.markets",
      dataBaseUrl: process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets",
      stockFeed: process.env.ALPACA_STOCK_FEED || "iex"
    },
    polygon: { key: process.env.POLYGON_API_KEY || "" },
    finnhub: { key: process.env.FINNHUB_API_KEY || "" }
  });
}

export { workspaceRoot };
