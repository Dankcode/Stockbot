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

test("runs arm backtests in parallel up to the limit, survives a failing arm and records progress", async (t) => {
  const { service, calls } = await harness(t, { verdicts: {
    selection: { "base-methods/ema-momentum": "worth-recording", "base-methods/rsi-mean-reversion": "inside-noise" },
    holdout: { "base-methods/ema-momentum": "worth-recording", "base-methods/rsi-mean-reversion": "worth-recording" }
  } });
  // Give the stub experiments real arm sessions so the service runs them itself.
  void service; void calls;
  let inFlight = 0;
  let peak = 0;
  const started = [];
  const harnessed = await harnessWithSessions(t, {
    onStart: async (id) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      started.push(id);
      if (id === "arm-3") throw new Error("engine timeout");
    }
  });
  const job = await harnessed.service.request({ symbols: ["NVDA"], startNow: false });
  await harnessed.service.drain();
  const [pick] = (await harnessed.service.getJob(job.jobId)).picks;
  assert.equal(pick.status, "completed");
  assert.ok(peak > 1 && peak <= 2, `peak parallelism ${peak} should respect the limit of 2`);
  const progress = pick.evidenceJson.progress;
  assert.equal(progress.phase, "done");
  assert.ok(Number.isFinite(pick.evidenceJson.timings.selectionMs));
  assert.ok(Number.isFinite(pick.evidenceJson.timings.totalMs));
  assert.ok(started.length >= 6, "every arm of both phases was started");
});

async function harnessWithSessions(t, { onStart }) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-autopick-arms-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const created = [];
  let armCounter = 0;
  let counter = 0;
  const service = createStrategyPickService({
    repositories,
    accountId: "default",
    seeds: 2,
    concurrency: 2,
    idFactory: () => `id-${String(++counter).padStart(4, "0")}-xxxxxxxx`,
    logger: null,
    loadPlugins: async () => ({ plugins: PLUGINS }),
    algorithms: {
      list: async () => ({ algorithms: METHODS }),
      get: async (id) => METHODS.find((m) => m.id === id)
    },
    market: { getBars: async () => ({ source: "synthetic", bars: Array.from({ length: 300 }, (_, i) => ({ time: Date.UTC(2024, 0, 1) + i * DAY })) }) },
    experiments: {
      async create(input) {
        created.push(input);
        const sessions = input.plan.arms.map((arm) => ({ id: `arm-${++armCounter}`, experimentArmId: arm.id }));
        return { experiment: { id: `exp-${created.length}` }, sessions };
      },
      async start() { throw new Error("service must start arms itself when sessions are returned"); },
      async report(id) {
        const input = created[Number(id.split("-")[1]) - 1];
        return { report: { groups: input.plan.groups.map((group) => ({
          strategy: { algorithmId: group.strategy.algorithmId, name: group.strategy.name, params: group.strategy.params },
          verdict: "worth-recording", percentile: 95, metrics: { returnPercent: 4, sharpe: 1, maxDrawdown: 5, closedTradeCount: 7 }
        })) } };
      }
    },
    supervisor: {
      async create(input) { return { id: "paper-1", ...input }; },
      async start(id) { await onStart(id); return { id }; }
    }
  });
  return { service };
}
