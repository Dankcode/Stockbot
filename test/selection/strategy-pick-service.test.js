import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createStrategyPickService } from "../../server/selection/strategy-pick-service.js";

const DAY = 86_400_000;
const version = (id) => ({ id: `${id}:v1` });
const METHODS = [
  { id: "base-methods/ema-momentum", name: "EMA momentum", role: "strategy", horizon: "weekly", plugin: { id: "base-methods" }, enabled: true, params: { fast: 12 }, version: version("ema") },
  { id: "base-methods/rsi-mean-reversion", name: "RSI reversion", role: "strategy", horizon: "weekly", plugin: { id: "base-methods" }, enabled: true, params: { period: 14 }, version: version("rsi") },
  { id: "core-controls/buy-and-hold", name: "Buy and hold", role: "benchmark", horizon: "none", plugin: { id: "core-controls" }, enabled: true, params: {}, version: version("bh") },
  { id: "core-controls/random-entry", name: "Random entry", role: "control", horizon: "none", plugin: { id: "core-controls" }, enabled: true, params: { seed: 1 }, version: version("rnd") }
];
const PLUGINS = [{ plugin: { id: "base-methods" }, pairings: [
  { strategy: "ema-momentum", controls: ["core-controls/buy-and-hold", "core-controls/random-entry"] },
  { strategy: "rsi-mean-reversion", controls: ["core-controls/buy-and-hold", "core-controls/random-entry"] }
] }];

async function harness(t, { verdicts, bars = 300, failSymbol = null }) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-autopick-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const calls = { experiments: [], sessions: [], started: [] };
  let counter = 0;
  const service = createStrategyPickService({
    repositories,
    accountId: "default",
    seeds: 3,
    idFactory: () => `id-${String(++counter).padStart(4, "0")}-xxxxxxxx`,
    clock: () => Date.UTC(2026, 10, 26),
    logger: null,
    loadPlugins: async () => ({ plugins: PLUGINS }),
    algorithms: {
      list: async () => ({ algorithms: METHODS }),
      get: async (id) => { const found = METHODS.find((m) => m.id === id); if (!found) throw new Error("unknown"); return found; }
    },
    market: {
      getBars: async (symbol) => {
        if (symbol === failSymbol) throw new Error("provider down");
        return { source: "synthetic", bars: Array.from({ length: symbol === "NEWCO" ? 40 : bars }, (_, i) => ({ time: Date.UTC(2024, 0, 1) + i * DAY })) };
      }
    },
    experiments: {
      async create(input) {
        calls.experiments.push(input);
        return { experiment: { id: `exp-${calls.experiments.length}` }, plan: input.plan };
      },
      async start() {},
      async report(id) {
        const input = calls.experiments[Number(id.split("-")[1]) - 1];
        const phase = input.selection.phase;
        return { report: { groups: input.plan.groups.map((group) => ({
          strategy: { algorithmId: group.strategy.algorithmId, name: group.strategy.name, params: group.strategy.params },
          verdict: verdicts[phase][group.strategy.algorithmId],
          percentile: 92,
          metrics: { returnPercent: 4, sharpe: 1, maxDrawdown: 5, closedTradeCount: 7 }
        })) } };
      }
    },
    supervisor: {
      async create(input) { calls.sessions.push(input); return { id: `session-${calls.sessions.length}`, ...input }; },
      async start(id) { calls.started.push(id); return { id, status: "armed" }; }
    }
  });
  return { service, calls, repositories };
}

test("picks the strategy that survives the holdout and starts a paper session with it", async (t) => {
  const { service, calls } = await harness(t, { verdicts: {
    selection: { "base-methods/ema-momentum": "worth-recording", "base-methods/rsi-mean-reversion": "inside-noise" },
    holdout: { "base-methods/ema-momentum": "below-passive", "base-methods/rsi-mean-reversion": "no-timing-edge" }
  } });
  const job = await service.request({ symbols: ["nvda"] });
  assert.equal(job.status, "running");
  await service.drain();
  const done = await service.getJob(job.jobId);
  assert.equal(done.status, "completed");
  const [pick] = done.picks;
  assert.equal(pick.outcome, "selected");
  assert.equal(pick.algorithmId, "base-methods/rsi-mean-reversion");
  assert.match(pick.reason, /held up on the 100-bar holdout/);
  assert.equal(pick.sessionId, "session-1");
  assert.equal(pick.selectionExperimentId, "exp-1");
  assert.equal(pick.holdoutExperimentId, "exp-2");
  assert.deepEqual(calls.experiments.map((e) => e.selection.phase), ["selection", "holdout"]);
  assert.ok(calls.experiments[0].windowEnd < calls.experiments[1].windowStart, "holdout never overlaps selection");
  assert.equal(calls.experiments[0].mode, "backtest");
  assert.equal(calls.sessions[0].mode, "paper");
  assert.equal(calls.sessions[0].algorithmVersionId, "rsi:v1");
  assert.deepEqual(calls.sessions[0].symbols, ["NVDA"]);
  assert.equal(calls.sessions[0].name, "Auto · RSI reversion — NVDA");
  assert.deepEqual(calls.started, ["session-1"]);
  assert.equal(pick.evidenceJson.ranked[0].id, "base-methods/ema-momentum");
});

test("one session per symbol, buy-and-hold fallback, and a failing symbol does not stop the rest", async (t) => {
  const { service, calls } = await harness(t, { failSymbol: "BAD", verdicts: {
    selection: { "base-methods/ema-momentum": "fails-floor", "base-methods/rsi-mean-reversion": "below-passive" },
    holdout: {}
  } });
  const job = await service.request({ symbols: ["AAA", "BAD", "NEWCO"], startNow: false });
  await service.drain();
  const done = await service.getJob(job.jobId);
  assert.equal(done.status, "partial");
  const bySymbol = Object.fromEntries(done.picks.map((p) => [p.symbol, p]));
  assert.equal(bySymbol.AAA.outcome, "fallback");
  assert.equal(bySymbol.AAA.algorithmId, "core-controls/buy-and-hold");
  assert.match(bySymbol.AAA.reason, /holds passively/);
  assert.equal(bySymbol.AAA.holdoutExperimentId, null, "nothing qualified, so no holdout ran");
  assert.equal(bySymbol.BAD.status, "failed");
  assert.match(bySymbol.BAD.error, /provider down/);
  assert.equal(bySymbol.NEWCO.outcome, "fallback");
  assert.match(bySymbol.NEWCO.reason, /Only 40 daily bars/);
  assert.equal(calls.sessions.length, 2);
  assert.equal(calls.started.length, 0, "startNow:false leaves drafts");
});

test("validation and restart recovery", async (t) => {
  const { service, repositories } = await harness(t, { verdicts: { selection: {}, holdout: {} } });
  await assert.rejects(service.request({ symbols: [] }), /1–10 valid symbols/);
  await assert.rejects(service.request({ symbols: ["A"], barInterval: "1hour" }), /daily bars/);
  await repositories.strategyPicks.create({ id: "stuck", jobId: "j", symbol: "X", barInterval: "1day", createdAt: 1 });
  assert.equal(await service.recover(), 1);
  assert.equal((await repositories.strategyPicks.getById("stuck")).status, "failed");
});
