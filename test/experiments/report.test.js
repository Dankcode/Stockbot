import assert from "node:assert/strict";
import test from "node:test";

import { buildExperimentPlan } from "../../server/experiments/plan.js";
import { VERDICTS, percentileOf, quantiles, renderExperimentTable, summarizeExperiment } from "../../server/experiments/report.js";

const METHODS = [
  { id: "pack/ema", name: "EMA", role: "strategy", params: {} },
  { id: "ctl/buy-and-hold", name: "Buy and Hold", role: "benchmark", params: { warmupBars: 1 } },
  { id: "ctl/fixed", name: "Fixed", role: "control", params: { entryEveryBars: 20, holdBars: 8 } },
  { id: "ctl/random", name: "Random", role: "control", params: { seed: 1 } }
];
const PLUGINS = [{ plugin: { id: "pack" }, pairings: [{ strategy: "ema", controls: ["ctl/buy-and-hold", "ctl/fixed", "ctl/random"], seeds: 10 }] }];

function metrics(overrides = {}) {
  return {
    returnPercent: 10,
    sharpe: 1,
    maxDrawdown: 12,
    exposurePercent: 40,
    tradeCount: 20,
    closedTradeCount: 10,
    openPosition: false,
    ...overrides
  };
}

function buildResults(plan, { strategy, passive, fixed, randoms }) {
  const results = new Map();
  for (const arm of plan.arms) {
    let value;
    if (arm.kind === "strategy") value = strategy;
    else if (arm.algorithmId === "ctl/buy-and-hold") value = passive;
    else if (arm.algorithmId === "ctl/fixed") value = fixed;
    else value = metrics({ returnPercent: randoms[arm.params.seed - 1] });
    results.set(arm.key, { arm, metrics: value, error: null });
  }
  return results;
}

const plan = buildExperimentPlan({ methods: METHODS, plugins: PLUGINS, selection: { symbol: "AAPL", strategies: ["pack/ema"], seeds: 10 } });
const weakRandoms = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test("percentile and quantiles handle empty and non-finite input", () => {
  assert.equal(percentileOf(5, []), null);
  assert.equal(percentileOf(Number.NaN, [1, 2]), null);
  assert.equal(percentileOf(5, [1, 2, 3, 4]), 100);
  assert.equal(percentileOf(2.5, [1, 2, 3, 4]), 50);
  assert.equal(quantiles([]), null);
  assert.deepEqual({ ...quantiles([3, 1, 2]) }, { count: 3, min: 1, p25: 2, median: 2, p75: 3, max: 3 });
});

test("a strategy that fails the minimum-return floor fails before other controls are considered", () => {
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: -4, sharpe: 9 }),
      passive: metrics({ returnPercent: -30, sharpe: -1 }),
      fixed: metrics({ returnPercent: -20 }),
      randoms: weakRandoms.map((value) => -value)
    })
  });
  assert.equal(report.groups[0].verdict, VERDICTS.FAILS_FLOOR);
});

test("a positive strategy below same-asset buy-and-hold on Sharpe is below passive", () => {
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: 30, sharpe: 0.8 }),
      passive: metrics({ returnPercent: 25, sharpe: 1.4 }),
      fixed: metrics({ returnPercent: 5 }),
      randoms: weakRandoms
    })
  });
  assert.equal(report.groups[0].verdict, VERDICTS.BELOW_PASSIVE);
});

test("an exposure-matched control that returns more means no timing edge", () => {
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: 12, sharpe: 1.5 }),
      passive: metrics({ returnPercent: 40, sharpe: 1.0 }),
      fixed: metrics({ returnPercent: 18, exposurePercent: 42 }),
      randoms: weakRandoms
    })
  });
  assert.equal(report.groups[0].verdict, VERDICTS.NO_TIMING_EDGE);
});

test("clearing the controls but sitting inside the random spread is noise", () => {
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: 25, sharpe: 1.5 }),
      passive: metrics({ returnPercent: 20, sharpe: 1.0 }),
      fixed: metrics({ returnPercent: 8, exposurePercent: 42 }),
      randoms: [5, 10, 15, 20, 24, 30, 35, 40, 45, 50]
    })
  });
  const group = report.groups[0];
  assert.equal(group.verdict, VERDICTS.INSIDE_NOISE);
  assert.equal(group.percentile, 50);
});

test("clearing every control at the top of the random distribution is worth recording", () => {
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: 60, sharpe: 1.9, exposurePercent: 44 }),
      passive: metrics({ returnPercent: 20, sharpe: 1.0 }),
      fixed: metrics({ returnPercent: 8, exposurePercent: 42 }),
      randoms: weakRandoms
    })
  });
  assert.equal(report.groups[0].verdict, VERDICTS.WORTH_RECORDING);
  assert.equal(report.groups[0].percentile, 100);
  assert.match(report.headline, /1 of 1 cleared every control/);
  assert.match(renderExperimentTable(report), /clears controls/);
});

test("an exposure mismatch is warned about even when the verdict is favourable", () => {
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: 60, sharpe: 1.9, exposurePercent: 95 }),
      passive: metrics({ returnPercent: 20, sharpe: 1.0 }),
      fixed: metrics({ returnPercent: 8, exposurePercent: 30 }),
      randoms: weakRandoms
    })
  });
  assert.equal(report.groups[0].verdict, VERDICTS.WORTH_RECORDING);
  assert.match(report.groups[0].warnings.join(" "), /Exposure gap 65\.0pp/);
});

test("a missing random distribution is incomplete rather than a pass", () => {
  const bare = buildExperimentPlan({
    methods: METHODS,
    plugins: PLUGINS,
    selection: { symbol: "AAPL", strategies: ["pack/ema"], controls: ["ctl/buy-and-hold"] }
  });
  const results = new Map(bare.arms.map((arm) => [arm.key, {
    arm,
    metrics: arm.kind === "strategy" ? metrics({ returnPercent: 60, sharpe: 2 }) : metrics({ returnPercent: 20, sharpe: 1 }),
    error: null
  }]));
  const report = summarizeExperiment({ plan: bare, results });
  assert.equal(report.groups[0].verdict, VERDICTS.INCOMPLETE);
  assert.match(report.headline, /No strategy cleared/);
});

test("a failed strategy arm is reported, not silently dropped", () => {
  const results = new Map(plan.arms.map((arm) => [arm.key, { arm, metrics: null, error: "provider timeout" }]));
  const report = summarizeExperiment({ plan, results });
  assert.equal(report.executedCount, 0);
  assert.equal(report.failedCount, plan.arms.length);
  assert.equal(report.groups[0].verdict, VERDICTS.INCOMPLETE);
  assert.match(report.groups[0].reason, /provider timeout/);
});

test("REGRESSION: clearing every control on too few trades is not a positive verdict", () => {
  // Found running the real automation: a strategy with two closed round trips cleared
  // every control on a 140-bar window and was reported as "worth recording" with the
  // trade count demoted to a warning underneath. The verdict is the line that gets read
  // and quoted, so it now carries the objection itself.
  const report = summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent: 60, sharpe: 1.9, exposurePercent: 44, tradeCount: 4, closedTradeCount: 2 }),
      passive: metrics({ returnPercent: 20, sharpe: 1.0 }),
      fixed: metrics({ returnPercent: 8, exposurePercent: 42 }),
      randoms: weakRandoms
    })
  });
  const group = report.groups[0];
  assert.equal(group.verdict, VERDICTS.INSUFFICIENT_EVIDENCE);
  assert.equal(group.percentile, 100, "it did clear the controls — that part is unchanged");
  assert.match(group.reason, /2 closed trades/);
  assert.match(report.headline, /No strategy cleared/);
  // The objection is stated once, as the verdict, not twice.
  assert.equal(group.warnings.filter((warning) => warning.includes("closed trades")).length, 0);
});

test("five closed trades is the threshold, and a losing strategy still fails on the merits", () => {
  const run = (closedTradeCount, returnPercent) => summarizeExperiment({
    plan,
    results: buildResults(plan, {
      strategy: metrics({ returnPercent, sharpe: 1.9, exposurePercent: 44, closedTradeCount }),
      passive: metrics({ returnPercent: 20, sharpe: 1.0 }),
      fixed: metrics({ returnPercent: 8, exposurePercent: 42 }),
      randoms: weakRandoms
    })
  }).groups[0].verdict;
  assert.equal(run(4, 60), VERDICTS.INSUFFICIENT_EVIDENCE);
  assert.equal(run(5, 60), VERDICTS.WORTH_RECORDING);
  // A thin sample does not launder a loss into "insufficient evidence".
  assert.equal(run(2, -5), VERDICTS.FAILS_FLOOR);
});

test("too few seeds and too few trades are surfaced as warnings", () => {
  const small = buildExperimentPlan({ methods: METHODS, plugins: PLUGINS, selection: { symbol: "AAPL", strategies: ["pack/ema"], seeds: 3 } });
  const report = summarizeExperiment({
    plan: small,
    results: buildResults(small, {
      strategy: metrics({ returnPercent: 60, sharpe: 2, closedTradeCount: 2 }),
      passive: metrics({ returnPercent: 20, sharpe: 1 }),
      fixed: metrics({ returnPercent: 5, exposurePercent: 40 }),
      randoms: [1, 2, 3]
    })
  });
  const warnings = report.groups[0].warnings.join(" ");
  assert.match(warnings, /Only 3 random seeds/);
});
