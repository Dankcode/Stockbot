import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { TOOLS, createApi, createServer, loadBridgeConfig, validateBaseUrl } from "../../scripts/mcp/stockbot-mcp.js";

const TOKEN = "t".repeat(40);

test("the operator token is only sent to Tailscale HTTPS names or loopback", () => {
  assert.equal(validateBaseUrl("https://oldlaptop.tail1234.ts.net"), "https://oldlaptop.tail1234.ts.net/");
  assert.equal(validateBaseUrl("http://127.0.0.1:4000"), "http://127.0.0.1:4000/");
  for (const unsafe of [
    "http://oldlaptop.tail1234.ts.net",      // plaintext over the tailnet name
    "https://evil.example.com",
    "https://ts.net.evil.example",
    "https://user:pass@oldlaptop.tail1234.ts.net",
    "ftp://127.0.0.1",
    "not a url",
    ""
  ]) {
    assert.throws(() => validateBaseUrl(unsafe), /STOCKBOT_URL/, unsafe);
  }
});

test("the config file must be owner-only and real env overrides it", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stockbot-mcp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "mcp.env");
  await writeFile(file, `STOCKBOT_URL=https://box.tail1.ts.net\nSTOCKBOT_API_TOKEN=${TOKEN}\n`);
  await chmod(file, 0o644);
  await assert.rejects(loadBridgeConfig({ STOCKBOT_MCP_ENV: file }), { code: "CONFIG_PERMISSIONS" });
  await chmod(file, 0o600);
  const config = await loadBridgeConfig({ STOCKBOT_MCP_ENV: file, STOCKBOT_URL: "http://127.0.0.1:4000" });
  assert.equal(config.baseUrl, "http://127.0.0.1:4000/");
  assert.equal(config.token, TOKEN);
});

test("no tool can upload code, change settings, liquidate or place raw orders", () => {
  const names = TOOLS.map((tool) => tool.name);
  for (const forbidden of ["upload", "algorithm_upload", "settings", "liquidate", "halt_all", "place_order", "research"]) {
    assert.ok(!names.some((name) => name.includes(forbidden)), forbidden);
  }
  const create = TOOLS.find((tool) => tool.name === "create_paper_session");
  assert.ok(!("mode" in create.inputSchema.properties), "mode is fixed to paper");
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method} ${pathname}${search}`;
    calls.push({ key, init });
    const handler = routes[key] ?? routes[`${init.method} ${pathname}`];
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: { code: "NOT_FOUND", message: key } }) };
    const data = typeof handler === "function" ? handler(init) : handler;
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { impl, calls };
}

test("create_paper_session resolves the current version, forces paper mode and fixed sizing, then starts", async () => {
  const { impl, calls } = fakeFetch({
    "GET /api/v1/algorithms/crypto-pack%2Fbtc-sma-crossover": { id: "crypto-pack/btc-sma-crossover", role: "strategy", params: { fast: 20, slow: 50 }, version: { id: "v1" } },
    "POST /api/v1/sessions": (init) => ({ id: "s1", status: "draft", ...JSON.parse(init.body) }),
    "POST /api/v1/sessions/s1/start": { id: "s1", status: "running", symbols: ["BTCUSD"], barInterval: "1hour" }
  });
  const api = createApi({ baseUrl: "https://box.tail1.ts.net/", token: TOKEN }, { fetchImpl: impl });
  const tool = TOOLS.find((item) => item.name === "create_paper_session");
  const result = await tool.run(api, { name: "BTC", algorithmId: "crypto-pack/btc-sma-crossover", symbols: ["btcusd"], barInterval: "1hour", params: { fast: 10 } });
  const created = JSON.parse(calls.find((call) => call.key === "POST /api/v1/sessions").init.body);
  assert.equal(created.mode, "paper");
  assert.equal(created.algorithmVersionId, "v1");
  assert.deepEqual(created.symbols, ["BTCUSD"]);
  assert.deepEqual(created.params, { fast: 10, slow: 50 });
  assert.deepEqual(created.riskProfile.sizing, { mode: "fixed_notional", fixedNotional: 10_000 });
  assert.equal(result.created.status, "running");
  assert.ok(calls.every((call) => call.init.headers["x-stockbot-token"] === TOKEN));
});

test("controls refuse to mutate without a usable token, and errors come back as tool errors", async () => {
  const outputs = [];
  const { impl } = fakeFetch({});
  const server = createServer({
    getApi: async () => createApi({ baseUrl: "http://127.0.0.1:4000/", token: "" }, { fetchImpl: impl }),
    write: (payload) => outputs.push(payload)
  });
  await server({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_control", arguments: { sessionId: "s1", action: "pause" } } });
  assert.equal(outputs[0].result.isError, true);
  assert.match(outputs[0].result.content[0].text, /AUTH_NOT_CONFIGURED/);
  await server({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(outputs[1].error.code, -32602);
  await server({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(outputs.length, 2, "notifications get no reply");
});

test("initialize negotiates a supported protocol version", async () => {
  const outputs = [];
  const server = createServer({ getApi: async () => null, write: (payload) => outputs.push(payload) });
  await server({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  await server({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(outputs[0].result.protocolVersion, "2024-11-05");
  assert.equal(outputs[1].result.protocolVersion, "2025-06-18");
  assert.ok(outputs[0].result.capabilities.tools);
});
