import assert from "node:assert/strict";
import test from "node:test";

import {
  ExperimentPlanError,
  buildExperimentPlan,
  indexMethods,
  indexPairings,
  resolveControls
} from "../../server/experiments/plan.js";

const METHODS = [
  { id: "pack/ema", name: "EMA Momentum", role: "strategy", params: { fast: 9, slow: 21 } },
  { id: "pack/rsi", name: "RSI Reversion", role: "strategy", params: { period: 14 } },
  { id: "ctl/buy-and-hold", name: "Buy and Hold", role: "benchmark", params: { warmupBars: 1 } },
  { id: "ctl/fixed", name: "Fixed Interval", role: "control", params: { entryEveryBars: 20, holdBars: 8 } },
  { id: "ctl/random", name: "Random Entry", role: "control", params: { seed: 1, entryProbability: 0.05 } }
];

const PLUGINS = [{
  plugin: { id: "pack" },
  pairings: [
    {
      strategy: "ema",
      controls: ["ctl/buy-and-hold", "ctl/fixed", "ctl/random"],
      controlParams: { "ctl/fixed": { entryEveryBars: 15, holdBars: 6 } },
      seeds: 5,
      notes: "Tune fixed-interval to match exposure."
    },
    { strategy: "rsi", controls: ["ctl/buy-and-hold", "ctl/random"], seeds: 5 }
  ]
}];

function plan(selection) {
  return buildExperimentPlan({ methods: METHODS, plugins: PLUGINS, selection, now: 1_700_000_000_000 });
}

test("pairings resolve unqualified strategy references against their own plugin", () => {
  const pairings = indexPairings(PLUGINS);
  assert.ok(pairings.has("pack/ema"));
  assert.equal(pairings.get("pack/ema").strategy, "pack/ema");
  assert.deepEqual([...pairings.get("pack/ema").controls], ["ctl/buy-and-hold", "ctl/fixed", "ctl/random"]);
});

test("automated selection expands a pairing into strategy, controls, and one arm per seed", () => {
  const result = plan({ symbol: "nvda", strategies: ["pack/ema"] });
  assert.equal(result.symbol, "NVDA");
  const group = result.groups[0];
  assert.equal(group.controlSource, "pairing");
  assert.equal(group.seeds, 5);
  // buy-and-hold + fixed + 5 random seeds
  assert.equal(group.controls.length, 7);
  assert.equal(group.controls.filter((arm) => arm.algorithmId === "ctl/random").length, 5);
  // Congruent params from the pairing reach the control.
  const fixed = group.controls.find((arm) => arm.algorithmId === "ctl/fixed");
  assert.deepEqual(fixed.params, { entryEveryBars: 15, holdBars: 6 });
});

test("manual controls override the declared pairing", () => {
  const result = plan({ symbol: "AAPL", strategies: ["pack/ema"], controls: ["ctl/buy-and-hold"], seeds: 3 });
  assert.equal(result.groups[0].controlSource, "manual");
  assert.deepEqual(result.groups[0].controls.map((arm) => arm.algorithmId), ["ctl/buy-and-hold"]);
});

test("a control pinned to an explicit seed is not fanned out", () => {
  const result = plan({
    symbol: "AAPL",
    strategies: ["pack/ema"],
    controls: [{ id: "ctl/random", params: { seed: 42 } }]
  });
  assert.equal(result.groups[0].controls.length, 1);
  assert.deepEqual(result.groups[0].controls[0].params, { seed: 42 });
});

test("an index control preserves its own symbol and does not deduplicate into the treatment series", () => {
  const result = plan({
    symbol: "NVDA",
    strategies: ["pack/ema"],
    controls: [
      { id: "ctl/buy-and-hold", symbol: "SPY" },
      { id: "ctl/buy-and-hold", symbol: "QQQ" }
    ]
  });
  assert.deepEqual(result.groups[0].controls.map((arm) => arm.symbol), ["SPY", "QQQ"]);
  assert.notEqual(result.groups[0].controls[0].key, result.groups[0].controls[1].key);
  assert.equal(result.groups[0].controls[0].id, "ctl/buy-and-hold@SPY");
});

test("identical arms across strategies are executed once, not per group", () => {
  const result = plan({ symbol: "AAPL", strategies: ["pack/ema", "pack/rsi"], seeds: 5 });
  const naive = result.groups.reduce((sum, group) => sum + 1 + group.controls.length, 0);
  // ema: 1 + (bah + fixed + 5 random) = 8; rsi: 1 + (bah + 5 random) = 7 -> 15 naive.
  assert.equal(naive, 15);
  // Shared: buy-and-hold and the five random seeds. 15 - 6 = 9 distinct arms.
  assert.equal(result.arms.length, 9);
  assert.equal(result.savedRuns, 6);
  // And both groups still see the shared arms.
  const emaBah = result.groups[0].controls.find((arm) => arm.algorithmId === "ctl/buy-and-hold");
  const rsiBah = result.groups[1].controls.find((arm) => arm.algorithmId === "ctl/buy-and-hold");
  assert.equal(emaBah.key, rsiBah.key);
});

test("param key order does not create a duplicate arm", () => {
  const a = plan({ symbol: "AAPL", strategies: [{ id: "pack/ema", params: { fast: 5, slow: 30 } }], controls: ["ctl/fixed"] });
  const b = plan({ symbol: "AAPL", strategies: [{ id: "pack/ema", params: { slow: 30, fast: 5 } }], controls: ["ctl/fixed"] });
  assert.equal(a.groups[0].strategy.key, b.groups[0].strategy.key);
});

test("a strategy with no pairing and no explicit controls is rejected, not run bare", () => {
  assert.throws(
    () => buildExperimentPlan({
      methods: [...METHODS, { id: "pack/orphan", name: "Orphan", role: "strategy", params: {} }],
      plugins: PLUGINS,
      selection: { symbol: "AAPL", strategies: ["pack/orphan"] }
    }),
    (error) => error instanceof ExperimentPlanError && error.code === "EXPERIMENT_CONTROLS_MISSING"
  );
});

test("a control cannot be promoted into the treatment arm", () => {
  assert.throws(
    () => plan({ symbol: "AAPL", strategies: ["ctl/fixed"], controls: ["ctl/buy-and-hold"] }),
    (error) => error.code === "EXPERIMENT_ROLE_INVALID"
  );
});

test("unknown methods, bad symbols, and out-of-range seeds are rejected", () => {
  assert.throws(() => plan({ symbol: "AAPL", strategies: ["nope/nope"] }), (e) => e.code === "EXPERIMENT_METHOD_UNKNOWN");
  assert.throws(() => plan({ symbol: "not a symbol", strategies: ["pack/ema"] }), (e) => e.code === "EXPERIMENT_SYMBOL_INVALID");
  assert.throws(() => plan({ symbol: "AAPL", strategies: ["pack/ema"], seeds: 0 }), ExperimentPlanError);
  assert.throws(() => plan({ symbol: "AAPL", strategies: [] }), (e) => e.code === "EXPERIMENT_NO_STRATEGY");
  assert.throws(
    () => plan({ symbol: "AAPL", strategies: Array.from({ length: 40 }, () => "pack/ema") }),
    (e) => e.code === "EXPERIMENT_TOO_MANY_STRATEGIES" && /narrow --all-strategies/.test(e.message)
  );
});

test("resolveControls prefers explicit controls and falls back to the pairing", () => {
  const pairings = indexPairings(PLUGINS);
  assert.equal(resolveControls({ strategyId: "pack/ema", explicitControls: ["ctl/fixed"], pairings }).source, "manual");
  assert.equal(resolveControls({ strategyId: "pack/ema", explicitControls: [], pairings }).source, "pairing");
  assert.equal(resolveControls({ strategyId: "pack/ema", explicitControls: null, pairings, seeds: 9 }).seeds, 9);
});

test("REGRESSION: arms are ordered strategy-first so a truncated list keeps the treatment arm", () => {
  // `experiment sessions` builds a compare link from the first four arms, and
  // SessionComparePage caps at four. With controls interned first, that link held four
  // controls and no strategy — a comparison with nothing to compare against.
  const result = plan({ symbol: "AAPL", strategies: ["pack/ema"], seeds: 5 });
  assert.equal(result.arms[0].kind, "strategy");
  assert.equal(result.arms[0].algorithmId, "pack/ema");
  assert.ok(result.arms.slice(0, 4).some((arm) => arm.kind === "strategy"));
});

test("plans are frozen so a runner cannot mutate the experiment it was handed", () => {
  const result = plan({ symbol: "AAPL", strategies: ["pack/ema"] });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.arms));
  assert.ok(Object.isFrozen(result.groups[0].strategy.params));
});

test("indexMethods accepts both registry descriptor shapes", () => {
  const index = indexMethods([
    { id: "a", name: "A", params: {}, plugin: { id: "p", role: "control", horizon: "none" } },
    { id: "b", name: "B", params: {}, role: "strategy", pluginId: "p" }
  ]);
  assert.equal(index.get("a").role, "control");
  assert.equal(index.get("b").role, "strategy");
});
