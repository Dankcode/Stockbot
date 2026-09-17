import assert from "node:assert/strict";
import test from "node:test";

import { buildExperimentPlan } from "../../server/experiments/plan.js";
import { createApiExecutor, runExperiment } from "../../server/experiments/runner.js";

const METHODS = [
  { id: "pack/ema", name: "EMA", role: "strategy", params: {} },
  { id: "ctl/buy-and-hold", name: "BAH", role: "benchmark", params: {} },
  { id: "ctl/random", name: "Random", role: "control", params: { seed: 1 } }
];
const PLUGINS = [{ plugin: { id: "pack" }, pairings: [{ strategy: "ema", controls: ["ctl/buy-and-hold", "ctl/random"], seeds: 4 }] }];
const plan = buildExperimentPlan({ methods: METHODS, plugins: PLUGINS, selection: { symbol: "AAPL", strategies: ["pack/ema"], seeds: 4 } });

test("every arm runs exactly once and results are keyed by arm", async () => {
  const seen = [];
  const results = await runExperiment({
    plan,
    concurrency: 3,
    execute: async (arm) => {
      seen.push(arm.id);
      return { metrics: { returnPercent: 1 } };
    }
  });
  assert.equal(seen.length, plan.arms.length);
  assert.equal(new Set(seen).size, plan.arms.length);
  assert.equal(results.size, plan.arms.length);
  for (const arm of plan.arms) assert.ok(results.has(arm.key));
});

test("the strategy arm is dispatched before any control", async () => {
  const order = [];
  await runExperiment({ plan, concurrency: 1, execute: async (arm) => { order.push(arm.kind); return { metrics: {} }; } });
  assert.equal(order[0], "strategy");
});

test("one failing arm does not abort the others", async () => {
  const results = await runExperiment({
    plan,
    concurrency: 2,
    execute: async (arm) => {
      if (arm.algorithmId === "ctl/buy-and-hold") {
        const error = new Error("provider unavailable");
        error.code = "PROVIDER_UNAVAILABLE";
        throw error;
      }
      return { metrics: { returnPercent: 2 } };
    }
  });
  const failed = [...results.values()].filter((entry) => entry.error);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, "PROVIDER_UNAVAILABLE");
  assert.equal([...results.values()].filter((entry) => entry.metrics).length, plan.arms.length - 1);
});

test("progress is reported once per arm with an ok flag", async () => {
  const events = [];
  await runExperiment({
    plan,
    concurrency: 1,
    execute: async (arm) => { if (arm.kind === "control") throw new Error("nope"); return { metrics: {} }; },
    onProgress: (event) => events.push(event)
  });
  assert.equal(events.length, plan.arms.length);
  assert.equal(events.at(-1).completed, plan.arms.length);
  assert.equal(events.filter((event) => event.ok).length, 1);
});

test("an aborted signal stops dispatching further arms", async () => {
  const controller = new AbortController();
  controller.abort();
  const results = await runExperiment({ plan, execute: async () => ({ metrics: {} }), signal: controller.signal });
  assert.equal(results.size, 0);
});

test("runExperiment refuses a plan with no executor", async () => {
  await assert.rejects(() => runExperiment({ plan }), TypeError);
});

test("the API executor posts the arm params and unwraps the envelope", async () => {
  const calls = [];
  const executor = createApiExecutor({
    baseUrl: "http://127.0.0.1:4000/",
    token: "x".repeat(32),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), token: init.headers["x-stockbot-token"] });
      return { ok: true, status: 200, json: async () => ({ data: { metrics: { returnPercent: 7 }, cache: { hit: true } } }) };
    }
  });
  const arm = plan.arms.find((entry) => entry.algorithmId === "ctl/random");
  const outcome = await executor(arm, plan);
  assert.equal(outcome.metrics.returnPercent, 7);
  assert.equal(outcome.cache.hit, true);
  assert.match(calls[0].url, /\/api\/v1\/algorithms\/ctl%2Frandom\/backtest$/);
  assert.deepEqual(calls[0].body, { symbol: "AAPL", range: "1Y", params: { seed: arm.params.seed } });
  assert.equal(calls[0].token.length, 32);
});

test("the API executor turns an error envelope into a coded error", async () => {
  const executor = createApiExecutor({
    baseUrl: "http://127.0.0.1:4000/",
    token: "x".repeat(32),
    fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ error: { code: "INSUFFICIENT_BARS", message: "not enough bars" } }) })
  });
  await assert.rejects(() => executor(plan.arms[0], plan), (error) => error.code === "INSUFFICIENT_BARS");
});

test("a response with no metrics is an error rather than an empty result", async () => {
  const executor = createApiExecutor({
    baseUrl: "http://127.0.0.1:4000/",
    token: "x".repeat(32),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) })
  });
  await assert.rejects(() => executor(plan.arms[0], plan), (error) => error.code === "EXPERIMENT_API_SHAPE");
});
