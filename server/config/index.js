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

function jsonValue(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

function stringArray(name) {
  const value = jsonValue(name, []);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings.`);
  }
  return Object.freeze(value.slice());
}

function record(name) {
  const value = jsonValue(name, {});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return Object.freeze({ ...value });
}

export function loadConfig() {
  const host = process.env.HOST || "127.0.0.1";
  const allowRemote = bool("STOCKBOT_ALLOW_REMOTE", false);
  const apiToken = secret("STOCKBOT_API_TOKEN");
  const databaseUrl = process.env.DATABASE_URL || `file:${path.join(workspaceRoot, "data/stockbot.db")}`;
  let databaseLocation = process.env.STOCKBOT_DATABASE_LOCATION || "";
  if (!databaseLocation) {
    try {
      const databaseHost = /^postgres(?:ql)?:\/\//i.test(databaseUrl) ? new URL(databaseUrl).hostname : "";
      databaseLocation = databaseHost && !["localhost", "127.0.0.1", "::1"].includes(databaseHost)
        ? "remote"
        : "local";
    } catch {
      databaseLocation = "local";
    }
  }
  if (!["local", "remote"].includes(databaseLocation)) {
    throw new Error("STOCKBOT_DATABASE_LOCATION must be local or remote.");
  }
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(host) && !allowRemote) {
    throw new Error("HOST must be loopback unless STOCKBOT_ALLOW_REMOTE=true is explicitly set.");
  }
  if (allowRemote && !apiToken) {
    throw new Error("STOCKBOT_API_TOKEN is required whenever remote binding is enabled.");
  }

  return Object.freeze({
    workspaceRoot,
    configFile: process.env.STOCKBOT_CONFIG_FILE || "",
    host,
    port: integer("PORT", 4000, { min: 1, max: 65535 }),
    databaseUrl,
    databaseLocation,
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
    researchWebSources: record("RESEARCH_WEB_SOURCES_JSON"),
    aiCli: Object.freeze({
      command: process.env.AI_CLI_COMMAND || "",
      args: stringArray("AI_CLI_ARGS_JSON"),
      model: process.env.AI_CLI_MODEL || "operator-configured-cli",
      timeoutMs: integer("AI_CLI_TIMEOUT_MS", 60_000, { min: 1_000, max: 600_000 }),
      maxInputBytes: integer("AI_CLI_MAX_INPUT_BYTES", 500_000, { min: 1_000, max: 5_000_000 }),
      maxOutputBytes: integer("AI_CLI_MAX_OUTPUT_BYTES", 100_000, { min: 1_000, max: 1_000_000 }),
      envAllowlist: stringArray("AI_CLI_ENV_ALLOWLIST_JSON")
    }),
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
