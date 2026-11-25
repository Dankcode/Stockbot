import assert from "node:assert/strict";
import test from "node:test";

import { LENSES } from "../../server/discovery/scoring.js";
import { attribute, learn, MAX_WEIGHT_CHANGE, spearman } from "../../server/swarm/learn.js";
import { bootstrapInterval, judgeArm } from "../../server/swarm/review.js";

function seeded(seed) {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
}

/** Trades where mom6m truly predicts beating SPY, vol1y truly hurts, and rsi14 is pure noise. */
export function plantedTrades(count, seed = 11) {
  const random = seeded(seed);
  return Array.from({ length: count }, (_, index) => {
    const mom6m = random() * 0.6 - 0.1;
    const vol1y = 0.2 + random() * 0.6;
    const rsi14 = 30 + random() * 40;
    const excessPct = 40 * (mom6m - 0.2) - 30 * (vol1y - 0.5) + (random() - 0.5) * 2;
    return { symbol: `S${index}`, entryAt: index * 86_400_000, excessPct, features: { mom6m, vol1y, rsi14, growthScore: 50 }, rationale: `trade ${index}` };
  });
}

test("Spearman is rank-based and symmetric", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 400]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), null, "no spread");
});

test("a planted predictor is stable in both halves; a noise feature is not", () => {
  const { features } = attribute(plantedTrades(60));
  const byKey = Object.fromEntries(features.map((feature) => [feature.key, feature]));
  assert.equal(byKey.mom6m.stable, true);
  assert.ok(byKey.mom6m.rho > 0.3);
  assert.equal(byKey.vol1y.stable, true);
  assert.ok(byKey.vol1y.rho < -0.3);
  assert.equal(byKey.rsi14.stable, false, "noise must not be learned");
  assert.equal(byKey.growthScore.stable, false, "a constant has no rank correlation");
});

test("learning raises the weight of what worked, within ±50%, and excludes the losing tercile", () => {
  const { model, lessons } = learn({ trades: plantedTrades(60), base: "growth", modelId: "m-1" });
  assert.ok(model);
  const base = Object.fromEntries(LENSES.growth.map((component) => [component.key, component.weight]));
  const change = lessons.weightChanges.find((entry) => entry.key === "mom6m");
  assert.ok(change.change > 0 && change.change <= MAX_WEIGHT_CHANGE, "bounded increase");
  assert.equal(change.from, base.mom6m);
  assert.ok(!lessons.weightChanges.some((entry) => entry.key === "rsi14"));
  const total = model.components.reduce((sum, component) => sum + component.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-5, "normalized");
  assert.deepEqual(model.components.map((component) => component.key), LENSES.growth.map((component) => component.key), "only base components are weighted");
  const volRule = model.exclude.find((rule) => rule.metric === "vol1y");
  assert.equal(volRule.condition, "greater_than", "high volatility lost to SPY");
  assert.ok(!model.exclude.some((rule) => rule.metric === "rsi14"));
});

test("fewer than 30 trades learns nothing", () => {
  const { model, lessons } = learn({ trades: plantedTrades(29), base: "growth", modelId: "m" });
  assert.equal(model, null);
  assert.match(lessons.reason, /at least 30/);
});

test("pure noise produces no model", () => {
  const random = seeded(99);
  const trades = Array.from({ length: 60 }, (_, index) => ({ symbol: `N${index}`, entryAt: index, excessPct: (random() - 0.5) * 10, features: { mom6m: random(), vol1y: random() } }));
  const { model } = learn({ trades, base: "hold", modelId: "m" });
  assert.equal(model, null);
});

test("the gauntlet: floor any day, nothing else before day 60, only a clear deficit retires", () => {
  const metrics = (extra = {}) => ({ returnPct: 1, maxDrawdownPct: -5, closedTrades: 10, ...extra });
  const below = Array.from({ length: 60 }, (_, index) => -0.001 + (index % 2 ? 0.0002 : -0.0002));
  const noisy = Array.from({ length: 60 }, (_, index) => (index % 2 ? 0.01 : -0.0101));
  const above = below.map((value) => -value);
  assert.equal(judgeArm({ metrics: metrics({ maxDrawdownPct: -26 }), excess: below, tradingDays: 10 }).verdict, "fails-floor");
  assert.equal(judgeArm({ metrics: metrics({ returnPct: -21 }), excess: below, tradingDays: 10 }).retire, true);
  assert.deepEqual(judgeArm({ metrics: metrics(), excess: below, tradingDays: 59 }), { verdict: "too-early", retire: false, interval: null }, "day 59 below control is not retired");
  const judged = judgeArm({ metrics: metrics(), excess: below, tradingDays: 60 });
  assert.deepEqual([judged.verdict, judged.retire], ["below-passive", true]);
  assert.ok(judged.interval[1] < 0);
  assert.deepEqual(Object.values(judgeArm({ metrics: metrics(), excess: noisy, tradingDays: 60 })).slice(0, 2), ["inside-noise", false], "bad luck is not evidence");
  assert.equal(judgeArm({ metrics: metrics({ closedTrades: 4 }), excess: above, tradingDays: 60 }).verdict, "insufficient-evidence");
  assert.equal(judgeArm({ metrics: metrics(), excess: above, tradingDays: 60 }).verdict, "worth-recording");
  assert.deepEqual(bootstrapInterval(below), bootstrapInterval(below), "deterministic");
});
