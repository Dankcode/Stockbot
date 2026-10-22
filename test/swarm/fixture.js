import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createStockbot } from "../../server/bootstrap.js";
import { loadConfig } from "../../server/config/index.js";

export const OPERATOR_TOKEN = "operator-token-that-is-at-least-32-characters-long";

export const PLAN = Object.freeze({
  kind: "stockbot.agent-plan.v1",
  name: "Index ETF watch",
  universe: { symbols: ["SPY", "QQQ"] },
  cadence: [{ task: "research", schedule: { type: "interval", minutes: 60 }, expiresAfterMinutes: 60 }],
  sources: ["market.quote", "market.bars"],
  decision: { minScore: 7, positionPercent: 8, stopLossPercent: 8, maxHoldDays: 40 }
});

/** A market whose every answer names its provider, so provenance is checkable. */
export function fixtureMarket({ provider = "synthetic-fixture", clock = () => Date.now(), price = 100 } = {}) {
  const bars = (symbol) => Array.from({ length: 30 }, (_, index) => ({
    time: Date.UTC(2026, 8, 1) + index * 86_400_000, open: price, high: price + 1, low: price - 1, close: price + index / 10, volume: 1_000_000
  }));
  return {
    calls: [],
    providerHealth: () => [],
    clearCaches() {},
    async getQuote(symbol) {
      this.calls.push(["quote", symbol]);
      return { symbol, price, previousClose: price, changePercent: 0, volume: 1_000_000, status: "real", source: provider, at: clock() };
    },
    async getBars(symbol, range = "3M") {
      this.calls.push(["bars", symbol, range]);
      return { symbol, range, interval: "1day", source: provider, bars: bars(symbol) };
    },
    async search() { return []; },
    async movers() { return []; },
    async selectionUniverse() { return { symbols: [], forwardTestOnly: false }; }
  };
}

/** The real Stockbot (migrations, repositories, routes, auth) on a scratch SQLite file. */
export async function bootStockbot(t, { market = fixtureMarket(), configOverrides = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-swarm-"));
  const databaseUrl = pathToFileURL(join(directory, "stockbot.db")).href;
  const config = {
    ...loadConfig(),
    databaseUrl,
    apiToken: OPERATOR_TOKEN,
    engineWorkers: 1,
    engineTimeoutMs: 2_000,
    swarmScheduler: false,
    ...configOverrides
  };
  const runtime = await createStockbot({ config, market });
  const server = await new Promise((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function call(method, path, { token, agentToken, body } = {}) {
    const response = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { "x-stockbot-token": token } : {}),
        ...(agentToken ? { "x-stockbot-agent-token": agentToken } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json();
    return { status: response.status, data: payload.data, error: payload.error };
  }
  const operator = (method, path, body) => call(method, path, { token: OPERATOR_TOKEN, body });
  const agent = (agentToken) => (method, path, body) => call(method, path, { agentToken, body });

  /** Operator flow: agent + sleeve + token + active plan. */
  async function provisionAgent(name, plan = PLAN) {
    const created = await operator("POST", "/swarm/agents", { name });
    if (created.status !== 201) throw new Error(`create agent failed: ${JSON.stringify(created.error)}`);
    const token = (await operator("POST", `/swarm/agents/${created.data.id}/tokens`)).data.token;
    const saved = await operator("POST", `/swarm/agents/${created.data.id}/plans`, { plan });
    if (saved.status !== 201) throw new Error(`save plan failed: ${JSON.stringify(saved.error)}`);
    return { agent: created.data, token, plan: saved.data.plan, api: agent(token) };
  }

  return { runtime, baseUrl, config, directory, databaseUrl, call, operator, agent, provisionAgent };
}
