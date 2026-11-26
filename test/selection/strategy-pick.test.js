import assert from "node:assert/strict";
import test from "node:test";

import { choosePick, eligibleStrategies, finalistsOf, rankGroups, splitWindow } from "../../server/selection/strategy-pick.js";

const v = { id: "v1" };
const METHODS = [
  { id: "base-methods/ema-momentum", role: "strategy", horizon: "weekly", plugin: { id: "base-methods" }, version: v },
  { id: "base-methods/rsi-mean-reversion", role: "strategy", horizon: "weekly", plugin: { id: "base-methods" }, version: v },
  { id: "core-controls/buy-and-hold", role: "benchmark", horizon: "none", plugin: { id: "core-controls" }, version: v },
  { id: "crypto-pack/btc-sma-crossover", role: "strategy", horizon: "weekly", plugin: { id: "crypto-pack" }, version: v },
  { id: "sentiment-pack/gated-momentum", role: "strategy", horizon: "weekly", plugin: { id: "sentiment-pack" }, version: v },
  { id: "horizon-pack/yearly-ema", role: "strategy", horizon: "yearly", plugin: { id: "horizon-pack" }, version: v },
  { id: "uploads/mine", role: "strategy", uploaded: true, version: v },
  { id: "ema-momentum", role: "strategy", version: v },
  { id: "momentum-pack/time-series-momentum", role: "strategy", horizon: "monthly", plugin: { id: "momentum-pack" }, enabled: false, version: v }
];
const PAIRINGS = new Map([
  "base-methods/ema-momentum", "base-methods/rsi-mean-reversion", "crypto-pack/btc-sma-crossover",
  "sentiment-pack/gated-momentum", "horizon-pack/yearly-ema", "uploads/mine", "momentum-pack/time-series-momentum"
].map((id) => [id, {}]));

test("eligibility keeps tradeable strategies and says why the rest were left out", () => {
  const { eligible, excluded } = eligibleStrategies(METHODS, { symbol: "NVDA", pairings: PAIRINGS });
  assert.deepEqual(eligible.map((m) => m.id), ["base-methods/ema-momentum", "base-methods/rsi-mean-reversion"]);
  const reasons = Object.fromEntries(excluded.map((e) => [e.id, e.reason]));
  assert.equal(reasons["crypto-pack/btc-sma-crossover"], "crypto-only method");
  assert.equal(reasons["sentiment-pack/gated-momentum"], "needs a research timeline");
  assert.match(reasons["horizon-pack/yearly-ema"], /yearly/);
  assert.match(reasons["uploads/mine"], /sandbox/);
  assert.equal(reasons["ema-momentum"], "declares no control group");
  assert.equal(reasons["momentum-pack/time-series-momentum"], "disabled");
  assert.ok(!("core-controls/buy-and-hold" in reasons), "controls are not candidates at all");
});

test("crypto symbols may use the crypto pack", () => {
  const { eligible } = eligibleStrategies(METHODS, { symbol: "BTCUSD", pairings: PAIRINGS });
  assert.ok(eligible.some((m) => m.id === "crypto-pack/btc-sma-crossover"));
});

test("uploads only compete when explicitly included", () => {
  const { eligible } = eligibleStrategies(METHODS, { symbol: "NVDA", pairings: PAIRINGS, includeUploads: true });
  assert.ok(eligible.some((m) => m.id === "uploads/mine"));
});

const DAY = 86_400_000;
const bars = (n) => Array.from({ length: n }, (_, i) => ({ time: Date.UTC(2024, 0, 1) + i * DAY, close: 1 }));

test("splitWindow gives disjoint older/newer windows covering every bar", () => {
  const split = splitWindow(bars(300));
  assert.equal(split.selection.bars, 200);
  assert.equal(split.holdout.bars, 100);
  assert.equal(split.holdout.start, split.selection.end + DAY);
  assert.equal(split.selection.start, Date.UTC(2024, 0, 1));
});

test("splitWindow refuses histories too short to test", () => {
  assert.equal(splitWindow(bars(100)), null);
  assert.equal(splitWindow([]), null);
});

const group = (id, verdict, percentile, sharpe, maxDrawdown = 10) => ({
  strategy: { algorithmId: id, name: id.toUpperCase(), params: { p: 1 } },
  verdict,
  reason: verdict,
  percentile,
  metrics: { returnPercent: 5, sharpe, maxDrawdown, closedTradeCount: 6 }
});

test("ranking orders by verdict tier, then percentile, Sharpe and drawdown", () => {
  const ranked = rankGroups([
    group("a", "inside-noise", 80, 2),
    group("b", "worth-recording", 91, 0.5),
    group("c", "worth-recording", 95, 0.4),
    group("d", "fails-floor", null, null),
    group("e", "insufficient-evidence", 99, 3),
    group("f", "worth-recording", 95, 0.4, 5)
  ]);
  assert.deepEqual(ranked.map((e) => e.id), ["f", "c", "b", "e", "a", "d"]);
});

test("finalists exclude strategies that lost money or lost to buy-and-hold", () => {
  const ranked = rankGroups([group("x", "below-passive", 99, 9), group("y", "fails-floor", null, -1), group("z", "inside-noise", 50, 1)]);
  assert.deepEqual(finalistsOf(ranked).map((e) => e.id), ["z"]);
});

test("the winner is the best finalist that holds up on the holdout", () => {
  const ranked = rankGroups([group("a", "worth-recording", 95, 1), group("b", "inside-noise", 70, 1)]);
  const finalists = finalistsOf(ranked);
  const pick = choosePick({ ranked, finalists, holdoutGroups: [group("a", "below-passive", 50, 0), group("b", "no-timing-edge", 40, 0.3)] });
  assert.equal(pick.outcome, "selected");
  assert.equal(pick.algorithmId, "b");
  assert.deepEqual(pick.params, { p: 1 });
  assert.match(pick.reason, /ranked #2 of 2/);
});

test("falls back to buy-and-hold when every finalist fails the holdout", () => {
  const ranked = rankGroups([group("a", "worth-recording", 95, 1)]);
  const pick = choosePick({ ranked, finalists: finalistsOf(ranked), holdoutGroups: [group("a", "fails-floor", null, -1)] });
  assert.equal(pick.outcome, "fallback");
  assert.equal(pick.algorithmId, null);
  assert.match(pick.reason, /held-out window/);
});

test("falls back when nothing qualifies in-sample", () => {
  const ranked = rankGroups([group("a", "below-passive", 99, 1)]);
  const pick = choosePick({ ranked, finalists: finalistsOf(ranked) });
  assert.equal(pick.outcome, "fallback");
  assert.match(pick.reason, /None of the 1 strategies/);
});
