#!/usr/bin/env node
/**
 * Stockbot MCP bridge — lets a local Claude (Claude Code or the Claude desktop app)
 * operate a Stockbot instance over Tailscale.
 *
 * Zero dependencies: a minimal MCP server speaking JSON-RPC 2.0 over stdio
 * (newline-delimited), exposing a deliberately small, allowlisted tool set on top of
 * the existing HTTP API. It is an operator console, not a raw API proxy:
 *
 *   - NO algorithm upload or edit (uploaded strategies can escape the node:vm sandbox;
 *     see the sandbox finding). Only installed strategies can be used.
 *   - NO settings, research-plan, liquidate-all, halt-all or raw order routes.
 *   - Paper sessions only; every created session is paper mode.
 *
 * Configuration (never pass the token on the command line or in MCP client config):
 *   STOCKBOT_MCP_ENV   path to a 0600 env file (default ~/.config/stockbot/mcp.env) with
 *                      STOCKBOT_URL=https://<host>.<tailnet>.ts.net
 *                      STOCKBOT_API_TOKEN=<the instance's API token>
 *   Real environment variables override the file.
 *
 * The token is only ever sent to a Tailscale Serve HTTPS name (*.ts.net) or to loopback,
 * so a mistyped or injected URL cannot ship the operator credential to the internet.
 */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_INFO = { name: "stockbot", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INTERVALS = ["1min", "5min", "1hour", "1day", "1week", "1month"];
const RANGES = ["1H", "1D", "1W", "1M", "3M", "1Y", "ALL"];

export class BridgeError extends Error {
  constructor(message, code = "STOCKBOT_MCP_ERROR") {
    super(message);
    this.code = code;
  }
}

export function parseEnvText(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export async function loadBridgeConfig(environment = process.env) {
  const file = environment.STOCKBOT_MCP_ENV || path.join(os.homedir(), ".config", "stockbot", "mcp.env");
  let fromFile = {};
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new BridgeError(`${file} is not a regular file.`, "CONFIG_INVALID");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new BridgeError(`${file} must be readable only by you (chmod 600).`, "CONFIG_PERMISSIONS");
    }
    fromFile = parseEnvText(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error?.code !== "ENOENT") throw new BridgeError(`Cannot read ${file}.`, "CONFIG_INVALID");
  }
  const merged = { ...fromFile, ...pick(environment, ["STOCKBOT_URL", "STOCKBOT_API_TOKEN"]) };
  return { baseUrl: validateBaseUrl(merged.STOCKBOT_URL), token: String(merged.STOCKBOT_API_TOKEN ?? ""), file };
}

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source[key]).map((key) => [key, source[key]]));
}

/** Only Tailscale Serve HTTPS names or loopback may receive the operator token. */
export function validateBaseUrl(value) {
  if (!value) throw new BridgeError("STOCKBOT_URL is not configured. Put it in ~/.config/stockbot/mcp.env.", "CONFIG_MISSING");
  let url;
  try { url = new URL(value); } catch { throw new BridgeError("STOCKBOT_URL is not a valid URL.", "CONFIG_INVALID"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const tailnet = url.protocol === "https:" && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(url.hostname);
  if (!(tailnet || (loopback && ["http:", "https:"].includes(url.protocol)))) {
    throw new BridgeError("STOCKBOT_URL must be a Tailscale Serve HTTPS address (https://<host>.<tailnet>.ts.net) or loopback.", "CONFIG_UNSAFE_URL");
  }
  if (url.username || url.password) throw new BridgeError("STOCKBOT_URL must not contain credentials.", "CONFIG_UNSAFE_URL");
  return `${url.origin}/`;
}

export function createApi({ baseUrl, token }, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  async function request(method, route, body) {
    const mutating = method !== "GET";
    if (mutating && token.length < 32) {
      throw new BridgeError("STOCKBOT_API_TOKEN is missing or too short; changes need the instance's API token.", "AUTH_NOT_CONFIGURED");
    }
    let response;
    try {
      response = await fetchImpl(new URL(`/api/v1${route}`, baseUrl), {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token ? { "x-stockbot-token": token } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new BridgeError(
        `Cannot reach Stockbot at ${baseUrl} (${error?.cause?.code ?? error?.name ?? "network error"}). Is Tailscale connected on this Mac and the oldlaptop online?`,
        "UNREACHABLE"
      );
    }
    let payload;
    try { payload = await response.json(); } catch {
      throw new BridgeError(`Stockbot returned non-JSON HTTP ${response.status}.`, "INVALID_RESPONSE");
    }
    if (!response.ok || payload?.error) {
      throw new BridgeError(payload?.error?.message ?? `Stockbot returned HTTP ${response.status}.`, payload?.error?.code ?? `HTTP_${response.status}`);
    }
    return payload.data;
  }
  return { get: (route) => request("GET", route), post: (route, body) => request("POST", route, body ?? {}) };
}

const listOf = (value) => {
  if (Array.isArray(value)) return value;
  for (const key of ["items", "algorithms", "sessions", "orders", "events"]) if (Array.isArray(value?.[key])) return value[key];
  return [];
};
const enc = encodeURIComponent;
const iso = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value)).toISOString() : null);
const dollars = (cents) => (Number.isFinite(Number(cents)) ? Math.round(Number(cents)) / 100 : null);

function requireString(args, key, { pattern, max = 200 } = {}) {
  const value = typeof args?.[key] === "string" ? args[key].trim() : "";
  if (!value) throw new BridgeError(`${key} is required.`, "INVALID_ARGUMENT");
  if (value.length > max || (pattern && !pattern.test(value))) throw new BridgeError(`${key} is invalid.`, "INVALID_ARGUMENT");
  return value;
}
const SYMBOL = /^[A-Za-z0-9./-]{1,32}$/;
const ID = /^[A-Za-z0-9:._/-]{1,160}$/;

function compactSession(session) {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    mode: session.mode,
    algorithmVersionId: session.algorithmVersionId,
    symbols: session.symbols ?? session.symbolsJson,
    barInterval: session.barInterval,
    accountId: session.accountId,
    startedAt: iso(session.startedAt),
    endedAt: iso(session.endedAt),
    stopReason: session.stopReason ?? null,
    errorDetail: session.errorDetail ?? null
  };
}

function compactOrder(order) {
  const fill = Array.isArray(order.fills) ? order.fills[0] : null;
  return {
    side: order.side,
    symbol: order.symbol,
    status: order.status,
    qty: Number(order.qty) / 1_000_000,
    fillPrice: fill ? dollars(fill.price) : null,
    submittedAt: iso(order.submittedAt),
    filledAt: iso(fill?.filledAt),
    reason: order.signalReason ?? null,
    rejectReason: order.rejectReason ?? null
  };
}

export const TOOLS = [
  {
    name: "stockbot_status",
    description: "Health of the Stockbot instance, data providers, paper account equity and active sessions. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(api) {
      const [health, overview] = await Promise.all([api.get("/health"), api.get("/overview").catch(() => null)]);
      return {
        ok: health?.ok ?? null,
        database: health?.database ?? null,
        providers: (health?.providers ?? []).map(({ id, status, configured, message }) => ({ id, status, configured, message })),
        portfolio: overview?.portfolio ? {
          accountId: overview.portfolio.accountId,
          equity: dollars(overview.portfolio.equity),
          cash: dollars(overview.portfolio.cash),
          positions: (overview.portfolio.positions ?? []).map((position) => ({ symbol: position.symbol, qty: Number(position.qty) / 1_000_000, marketValue: dollars(position.marketValue) }))
        } : null,
        activeSessions: listOf(overview?.activeSessions).map(compactSession)
      };
    }
  },
  {
    name: "list_strategies",
    description: "Installed strategies (id, name, description, default params, current version). Optional query filters by name/id/description.",
    inputSchema: { type: "object", properties: { query: { type: "string", maxLength: 80 } }, additionalProperties: false },
    async run(api, args) {
      const needle = String(args?.query ?? "").trim().toLowerCase();
      return listOf(await api.get("/algorithms"))
        .filter((algorithm) => !needle || [algorithm.id, algorithm.name, algorithm.description].some((text) => String(text ?? "").toLowerCase().includes(needle)))
        .map((algorithm) => ({ id: algorithm.id, name: algorithm.name, role: algorithm.role ?? null, description: algorithm.description ?? null, params: algorithm.params ?? {}, enabled: algorithm.enabled ?? null, versionId: algorithm.version?.id ?? null }));
    }
  },
  {
    name: "market_quote",
    description: "Latest real quote for a symbol (e.g. BTCUSD, SPY).",
    inputSchema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"], additionalProperties: false },
    async run(api, args) {
      const symbol = requireString(args, "symbol", { pattern: SYMBOL }).toUpperCase();
      const quote = await api.get(`/market/quote/${enc(symbol)}`);
      return { ...quote, at: iso(quote?.at) ?? quote?.at };
    }
  },
  {
    name: "market_bars",
    description: "Recent OHLCV bars for a symbol. range: 1H|1D|1W(1-hour bars)|1M|3M(daily)|1Y|ALL. Returns at most `limit` most recent bars (default 60).",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" }, range: { type: "string", enum: RANGES }, limit: { type: "integer", minimum: 1, maximum: 500 } },
      required: ["symbol"],
      additionalProperties: false
    },
    async run(api, args) {
      const symbol = requireString(args, "symbol", { pattern: SYMBOL }).toUpperCase();
      const range = RANGES.includes(args?.range) ? args.range : "1W";
      const limit = Math.min(500, Math.max(1, Number(args?.limit) || 60));
      const data = await api.get(`/market/bars/${enc(symbol)}?range=${enc(range)}`);
      const bars = (data?.bars ?? []).slice(-limit).map((bar) => ({ time: iso(bar.time) ?? bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
      return { symbol, range, interval: data?.interval, source: data?.source, count: bars.length, bars };
    }
  },
  {
    name: "backtest_strategy",
    description: "Backtest an installed strategy on one symbol over a recent range (read-only; nothing trades). Returns metrics vs controls.",
    inputSchema: {
      type: "object",
      properties: {
        algorithmId: { type: "string" },
        symbol: { type: "string" },
        range: { type: "string", enum: RANGES },
        params: { type: "object", additionalProperties: { type: ["number", "string", "boolean"] } }
      },
      required: ["algorithmId", "symbol"],
      additionalProperties: false
    },
    async run(api, args) {
      const algorithmId = requireString(args, "algorithmId", { pattern: ID });
      const symbol = requireString(args, "symbol", { pattern: SYMBOL }).toUpperCase();
      const result = await api.post(`/algorithms/${enc(algorithmId)}/backtest`, {
        symbol,
        ...(RANGES.includes(args?.range) ? { range: args.range } : {}),
        ...(args?.params ? { params: args.params } : {})
      });
      const run = result?.run ?? result?.result ?? result;
      const readable = (metrics) => metrics ? { ...metrics, finalEquity: dollars(metrics.finalEquity) } : null;
      return {
        algorithmId,
        symbol,
        note: "Equity in dollars from a $100,000 start. Controls are buy-and-hold index funds over the same window.",
        metrics: readable(run?.metrics),
        controls: (run?.controls ?? []).map((control) => ({ id: control.id ?? control.label, metrics: readable(control.metrics) })),
        comparison: run?.comparison ?? null,
        trades: Array.isArray(run?.trades) ? run.trades.length : null
      };
    }
  },
  {
    name: "list_sessions",
    description: "Trading sessions (most recent first). Optional status filter: running|paused|halted|stopped|errored|draft.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["running", "paused", "halted", "stopped", "errored", "draft"] } }, additionalProperties: false },
    async run(api, args) {
      const query = args?.status ? `&status=${enc(args.status)}` : "";
      return listOf(await api.get(`/sessions?limit=100${query}`)).map(compactSession);
    }
  },
  {
    name: "session_report",
    description: "Everything about one session: config, latest equity, return since start, open/pending/filled/rejected orders with reasons, and recent events.",
    inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"], additionalProperties: false },
    async run(api, args) {
      const id = requireString(args, "sessionId", { pattern: ID });
      const [detail, orders, events, equity] = await Promise.all([
        api.get(`/sessions/${enc(id)}`),
        api.get(`/sessions/${enc(id)}/orders?limit=100`),
        api.get(`/sessions/${enc(id)}/events?limit=40`),
        api.get(`/sessions/${enc(id)}/equity?resolution=200`)
      ]);
      const session = detail?.session ?? detail;
      const points = listOf(equity);
      const first = Number(points[0]?.equity);
      const last = Number(points.at(-1)?.equity);
      const orderList = listOf(orders);
      return {
        session: { ...compactSession(session), params: session.params ?? session.paramsJson, riskProfile: session.riskProfile ?? session.riskProfileJson },
        equity: points.length ? { first: dollars(first), latest: dollars(last), returnPercent: first > 0 ? Number((((last / first) - 1) * 100).toFixed(3)) : null, lastCheck: iso(points.at(-1)?.at), points: points.length } : null,
        orders: {
          pending: orderList.filter((order) => order.status === "pending").map(compactOrder),
          filled: orderList.filter((order) => order.status === "filled").slice(0, 20).map(compactOrder),
          rejected: orderList.filter((order) => order.status === "rejected").slice(0, 10).map(compactOrder)
        },
        recentEvents: listOf(events).slice(0, 25).map((event) => ({ at: iso(event.at), type: event.action ?? event.type, detail: event.detailJson ?? null }))
      };
    }
  },
  {
    name: "create_paper_session",
    description: "Create (and by default start) a PAPER trading session for an installed strategy. The strategy's own rules make every buy/sell decision; Stockbot executes them with simulated money. sizingNotional sets dollars per entry; stopLossPercent is a protective catastrophe stop (default 15).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", maxLength: 200 },
        algorithmId: { type: "string" },
        symbols: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
        barInterval: { type: "string", enum: INTERVALS },
        params: { type: "object", additionalProperties: { type: ["number", "string", "boolean"] } },
        sizingNotional: { type: "number", minimum: 10, maximum: 50_000 },
        stopLossPercent: { type: "number", minimum: 1, maximum: 50 },
        start: { type: "boolean" }
      },
      required: ["name", "algorithmId", "symbols", "barInterval"],
      additionalProperties: false
    },
    async run(api, args) {
      const name = requireString(args, "name", { max: 200 });
      const algorithmId = requireString(args, "algorithmId", { pattern: ID });
      if (!INTERVALS.includes(args?.barInterval)) throw new BridgeError("barInterval is invalid.", "INVALID_ARGUMENT");
      const symbols = (args?.symbols ?? []).map((symbol) => String(symbol).trim().toUpperCase());
      if (!symbols.length || symbols.length > 20 || !symbols.every((symbol) => SYMBOL.test(symbol))) throw new BridgeError("symbols are invalid.", "INVALID_ARGUMENT");
      const algorithm = await api.get(`/algorithms/${enc(algorithmId)}`);
      const versionId = algorithm?.version?.id;
      if (!versionId) throw new BridgeError(`Strategy ${algorithmId} has no installed version on this instance.`, "STRATEGY_NOT_INSTALLED");
      if (algorithm.role && algorithm.role !== "strategy") throw new BridgeError(`${algorithmId} is a ${algorithm.role}, not a strategy.`, "INVALID_ARGUMENT");
      const notional = Number(args?.sizingNotional ?? 10_000);
      const stopLoss = Number(args?.stopLossPercent ?? 15);
      let session = await api.post("/sessions", {
        name,
        mode: "paper",
        algorithmVersionId: versionId,
        symbols,
        barInterval: args.barInterval,
        params: { ...(algorithm.params ?? {}), ...(args?.params ?? {}) },
        riskProfile: {
          name: "Claude operator paper",
          sizing: { mode: "fixed_notional", fixedNotional: notional },
          rules: { positionStopLoss: { enabled: true, percent: stopLoss } }
        }
      });
      if (args?.start !== false) session = await api.post(`/sessions/${enc(session.id)}/start`);
      return { created: compactSession(session), params: { ...(algorithm.params ?? {}), ...(args?.params ?? {}) }, sizingNotional: notional, stopLossPercent: stopLoss };
    }
  },
  {
    name: "session_control",
    description: "Change a session's state: start | pause | resume | stop | halt. halt keeps open positions (no liquidation).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" }, action: { type: "string", enum: ["start", "pause", "resume", "stop", "halt"] }, reason: { type: "string", maxLength: 300 } },
      required: ["sessionId", "action"],
      additionalProperties: false
    },
    async run(api, args) {
      const id = requireString(args, "sessionId", { pattern: ID });
      const action = args?.action;
      if (!["start", "pause", "resume", "stop", "halt"].includes(action)) throw new BridgeError("action is invalid.", "INVALID_ARGUMENT");
      const reason = typeof args?.reason === "string" ? args.reason.slice(0, 300) : "Claude operator";
      const body = action === "halt" ? { liquidate: false, reason } : action === "stop" ? { reason } : undefined;
      const result = await api.post(`/sessions/${enc(id)}/${action}`, body);
      return compactSession(result?.session ?? result);
    }
  },
  {
    name: "account_portfolio",
    description: "Cash, equity and positions of a paper account (default: default-paper).",
    inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
    async run(api, args) {
      const accountId = typeof args?.accountId === "string" && ID.test(args.accountId) ? args.accountId : "default-paper";
      const portfolio = await api.get(`/accounts/${enc(accountId)}/portfolio`);
      return {
        accountId,
        equity: dollars(portfolio?.equity),
        cash: dollars(portfolio?.cash),
        realizedPnl: dollars(portfolio?.realizedPnl),
        positions: (portfolio?.positions ?? []).map((position) => ({ symbol: position.symbol, qty: Number(position.qty) / 1_000_000, marketValue: dollars(position.marketValue), unrealizedPnl: dollars(position.unrealizedPnl) }))
      };
    }
  }
];

const INSTRUCTIONS = "Stockbot is a paper-trading hub. Strategies make the trading decisions; you operate sessions (create, monitor, pause, report). Never claim a trade happened unless session_report shows a filled order. Report rejections with their reasons.";

export function createServer({ getApi, write, tools: toolList = TOOLS, instructions = INSTRUCTIONS, serverInfo = SERVER_INFO }) {
  const tools = new Map(toolList.map((tool) => [tool.name, tool]));
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } });

  return async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message && "id" in message) fail(message.id ?? null, -32600, "Invalid request");
      return;
    }
    const { id, method, params } = message;
    const isNotification = !("id" in message);
    try {
      if (method === "initialize") {
        const requested = params?.protocolVersion;
        return reply(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions
        });
      }
      if (isNotification) return; // notifications/initialized, cancelled, etc.
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") {
        return reply(id, { tools: toolList.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      }
      if (method === "tools/call") {
        const tool = tools.get(params?.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
        try {
          const api = await getApi();
          const result = await tool.run(api, params?.arguments ?? {});
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], isError: false });
        } catch (error) {
          const text = `${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`;
          return reply(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      return fail(id, -32601, `Method not found: ${method}`);
    } catch (error) {
      if (!isNotification) fail(id, -32603, error?.message ?? "Internal error");
    }
  };
}

async function main() {
  let apiPromise;
  const getApi = () => (apiPromise ??= loadBridgeConfig().then((config) => createApi(config)).catch((error) => {
    apiPromise = undefined; // allow fixing the config without restarting the client
    throw error;
  }));
  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  const handle = createServer({ getApi, write });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    void handle(message);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
