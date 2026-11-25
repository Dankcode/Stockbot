import assert from "node:assert/strict";
import test from "node:test";

import { AgentPlanSchema } from "../../packages/shared/swarm.js";
import { discoveryFreshSince, isTradingDate, nyInstant, previousTradingDate } from "../../server/swarm/calendar.js";
import { resolveTaskUniverse, scoreWithModel, taskSymbols } from "../../server/swarm/universe.js";
import { PLAN } from "./fixture.js";

const NOW = nyInstant("2026-11-30", 10, 15); // Monday after Thanksgiving week
const FRESH = discoveryFreshSince(NOW);

function candidate(symbol, growthScore, holdScore, metrics = {}) {
  return { symbol, growthScore, holdScore, metricsJson: { price: 20, mom6m: 0.1, vol1y: 0.4, ...metrics }, fundamentalsJson: { revenueGrowthTTM: 12, version: 2 } };
}

// 14 candidates, scores 100..35 by growth; hold reverses the order. One has no score at all.
const CANDIDATES = [
  ...Array.from({ length: 13 }, (_, index) => candidate(`G${String.fromCharCode(65 + index)}`, 100 - index * 5, 40 + index * 5)),
  candidate("NOSC", null, null)
];
const RUN = { id: "run-1", status: "completed", completedAt: nyInstant("2026-11-30", 10, 5) };
const discoveryPlan = (discovery, extra = {}) => ({ ...PLAN, universe: { symbols: ["SPY"], discovery, ...extra } });

test("old pinned-only plans still parse unchanged; a universe needs pins or discovery", () => {
  assert.deepEqual(AgentPlanSchema.parse(PLAN).universe, { symbols: ["SPY", "QQQ"] });
  assert.equal(AgentPlanSchema.safeParse({ ...PLAN, universe: {} }).success, false);
  assert.equal(AgentPlanSchema.safeParse({ ...PLAN, universe: { symbols: [] } }).success, false);
  assert.equal(AgentPlanSchema.safeParse({ ...PLAN, universe: { discovery: { score: "growth", top: 9 } } }).success, true);
  assert.equal(AgentPlanSchema.safeParse(discoveryPlan({ score: "growth", top: 26 })).success, false, "top above 25");
  assert.equal(AgentPlanSchema.safeParse(discoveryPlan({ score: "learned", top: 9 })).success, false, "learned without a model");
  assert.equal(AgentPlanSchema.safeParse(discoveryPlan({ score: "growth", top: 9, learned: { modelId: "m", base: "growth", components: [{ key: "mom6m", weight: 1, direction: 1, kind: "rank" }] } })).success, false);
  assert.equal(AgentPlanSchema.safeParse({ ...PLAN, universe: { symbols: ["SPY", "SPY"] } }).success, false, "duplicate pin");
  assert.equal(AgentPlanSchema.safeParse({ ...PLAN, universe: { symbols: ["SPY", "QQQ"], discovery: { score: "hold", top: 9 }, totalCap: 1 } }).success, false, "pins above cap");
  assert.equal(AgentPlanSchema.safeParse({ ...PLAN, universe: { symbols: ["SPY"], extra: true } }).success, false, "strict");
});

test("SPY plus the top 9 by the arm's score makes a total of 10; the lenses pick different names", () => {
  const growth = resolveTaskUniverse({ universe: discoveryPlan({ score: "growth", top: 9 }).universe, run: RUN, candidates: CANDIDATES, holdings: [], freshSince: FRESH, now: NOW });
  assert.equal(growth.symbols.length, 10);
  assert.deepEqual(growth.symbols, ["SPY", "GA", "GB", "GC", "GD", "GE", "GF", "GG", "GH", "GI"]);
  assert.equal(growth.entries[0].source, "pinned");
  assert.deepEqual(growth.entries[1], { symbol: "GA", source: "discovery", rank: 1, score: 100, lens: "growth", features: growth.entries[1].features });
  assert.equal(growth.entries[1].features.revenueGrowthTTM, 12);
  assert.equal(growth.entries[1].features.version, undefined, "bookkeeping fields are not features");
  assert.equal(growth.discovery.fallback, null);
  assert.equal(growth.discovery.runId, "run-1");

  const hold = resolveTaskUniverse({ universe: discoveryPlan({ score: "hold", top: 9 }).universe, run: RUN, candidates: CANDIDATES, holdings: [], freshSince: FRESH, now: NOW });
  assert.equal(hold.symbols[1], "GM", "hold ranks the other way");
  assert.ok(!hold.symbols.includes("NOSC") && !growth.symbols.includes("NOSC"), "an unscored candidate is never picked");
});

test("top above the remaining cap is clipped, minScore drops weak names, holdings ride on top of the cap", () => {
  const universe = { symbols: ["SPY", "QQQ"], discovery: { score: "growth", top: 25, minScore: 75 }, totalCap: 10 };
  const resolved = resolveTaskUniverse({ universe, run: RUN, candidates: CANDIDATES, holdings: ["ZZZ", "GA"], freshSince: FRESH, now: NOW });
  assert.deepEqual(resolved.symbols, ["SPY", "QQQ", "GA", "GB", "GC", "GD", "GE", "GF", "ZZZ"], "scores 100..75 only; GA not duplicated; ZZZ held");
  assert.equal(resolved.entries.at(-1).source, "holding");
});

test("a stale, failed or missing run falls back to pins plus holdings and says why", () => {
  const universe = discoveryPlan({ score: "growth", top: 9 }).universe;
  const lastWeek = { ...RUN, completedAt: nyInstant("2026-11-25", 10, 5) }; // before Friday 27th
  const cases = [
    [lastWeek, "discovery_stale"],
    [{ ...RUN, status: "failed" }, "discovery_failed"],
    [null, "discovery_unavailable"]
  ];
  for (const [run, fallback] of cases) {
    const resolved = resolveTaskUniverse({ universe, run, candidates: CANDIDATES, holdings: ["HELD"], freshSince: FRESH, now: NOW });
    assert.deepEqual(resolved.symbols, ["SPY", "HELD"], fallback);
    assert.equal(resolved.discovery.fallback, fallback);
  }
  const friday = { ...RUN, completedAt: nyInstant("2026-11-27", 10, 5) };
  assert.equal(resolveTaskUniverse({ universe, run: friday, candidates: CANDIDATES, holdings: [], freshSince: FRESH, now: NOW }).discovery.fallback, null, "Friday's run is fresh on Monday");
  assert.equal(resolveTaskUniverse({ universe, run: RUN, candidates: [], holdings: [], freshSince: FRESH, now: NOW }).discovery.fallback, "discovery_empty");
});

test("a learned model re-ranks the run and its exclusion rules remove names", () => {
  const candidates = [
    candidate("LOWVOL", 10, 10, { vol1y: 0.2, mom6m: 0.0 }),
    candidate("MID", 50, 50, { vol1y: 0.5, mom6m: 0.2 }),
    candidate("HIVOL", 90, 90, { vol1y: 0.9, mom6m: 0.4 })
  ];
  const learned = { modelId: "m1", base: "hold", components: [{ key: "vol1y", weight: 1, direction: -1, kind: "rank" }], exclude: [{ metric: "mom6m", condition: "greater_than", value: 0.3 }] };
  assert.deepEqual([...scoreWithModel(candidates, learned)], [["LOWVOL", 100], ["MID", 50], ["HIVOL", 0]]);
  const resolved = resolveTaskUniverse({ universe: { discovery: { score: "learned", top: 5, learned } }, run: RUN, candidates, holdings: [], freshSince: FRESH, now: NOW });
  assert.deepEqual(resolved.symbols, ["LOWVOL", "MID"], "HIVOL excluded by the rule despite the best growth score");
});

test("old tasks without a frozen universe fall back to the plan's pins", () => {
  assert.deepEqual(taskSymbols({}, { universe: { symbols: ["SPY"] } }), ["SPY"]);
  assert.deepEqual(taskSymbols({ universeJson: { symbols: ["SPY", "GA"] } }, { universe: { symbols: ["SPY"] } }), ["SPY", "GA"]);
});

test("the calendar skips weekends and NYSE holidays", () => {
  assert.equal(isTradingDate("2026-11-26"), false, "Thanksgiving");
  assert.equal(isTradingDate("2026-11-28"), false, "Saturday");
  assert.equal(isTradingDate("2026-11-27"), true);
  assert.equal(previousTradingDate("2026-11-27"), "2026-11-25");
  assert.equal(previousTradingDate("2026-11-30"), "2026-11-27");
});
