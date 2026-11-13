import assert from "node:assert/strict";
import test from "node:test";

import { ROTATION_MIN_BARS, rankRotation, rebalanceOrders, rotationFactors, targetWeights } from "../../server/selection/rotation.js";
import { runRotationBacktest } from "../../server/selection/rotation-backtest.js";
import { createRotationService } from "../../server/selection/rotation-service.js";
import { rotationSector } from "../../server/selection/rotation-universe.js";

const DAY = 86_400_000;
const START = Date.UTC(2022, 0, 3, 5);

/** Deterministic test fixture. Never used outside tests: the product only ranks real bars. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function series(symbol, length, { drift = 0.0004, vol = 0.012, seed = 1, start = 100, volume = 2_000_000 } = {}) {
  const random = seeded(seed);
  let close = start;
  const bars = [];
  for (let index = 0; index < length; index += 1) {
    const shock = (random() + random() + random() - 1.5) * vol * 2;
    const open = close * (1 + (random() - 0.5) * vol * 0.3);
    close = Math.max(1, close * Math.exp(drift + shock));
    bars.push({ time: START + index * DAY, open, high: Math.max(open, close) * 1.004, low: Math.min(open, close) * 0.996, close, volume });
  }
  return { symbol, bars };
}

const NAMES = ["AAPL", "MSFT", "NVDA", "AMD", "JPM", "GS", "XOM", "CVX", "LLY", "UNH", "CAT", "GE", "COST", "WMT"];

function universe(length = 420, { spyDrift = 0.0005 } = {}) {
  const bars = { SPY: series("SPY", length, { drift: spyDrift, vol: 0.008, seed: 99, start: 400, volume: 80_000_000 }).bars };
  NAMES.forEach((symbol, index) => {
    bars[symbol] = series(symbol, length, { drift: 0.0002 + index * 0.00012, vol: 0.01 + (index % 4) * 0.004, seed: index + 7, volume: 3_000_000 }).bars;
  });
  return bars;
}

test("factors use only history through the decision bar", () => {
  const { bars } = series("AAPL", 400, { seed: 3 });
  const atEnd = rotationFactors(bars, 300);
  const truncated = rotationFactors(bars.slice(0, 301));
  assert.deepEqual(atEnd, truncated);
  assert.equal(atEnd.bars, 301);
  assert.ok(Number.isFinite(atEnd.mom12_1) && Number.isFinite(atEnd.vol20) && Number.isFinite(atEnd.rsi14));
});

test("ranking picks from the universe, sorts by score, caps sectors and skips the benchmark", () => {
  const result = rankRotation(universe(), { topN: 6, maxPerSector: 1, requireTrend: false });
  const scores = result.rows.map((row) => row.score).filter((value) => value !== null);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.ok(result.selected.length > 0 && result.selected.length <= 6);
  assert.ok(!result.selected.includes("SPY"));
  const sectors = result.selected.map(rotationSector);
  assert.equal(new Set(sectors).size, sectors.length, "maxPerSector 1 allows one name per sector");
});

test("gates exclude with a stated blocker instead of scoring down", () => {
  const bars = universe();
  bars.AMD = bars.AMD.slice(-100);
  bars.GE = bars.GE.map((bar) => ({ ...bar, volume: 1000 }));
  const rows = Object.fromEntries(rankRotation(bars, { requireTrend: false }).rows.map((row) => [row.symbol, row]));
  assert.equal(rows.AMD.eligible, false);
  assert.match(rows.AMD.blockers.join(";"), new RegExp(`${ROTATION_MIN_BARS} needed`));
  assert.equal(rows.AMD.score, null, "short history is not given a score");
  assert.equal(rows.GE.eligible, false);
  assert.match(rows.GE.blockers.join(";"), /dollar volume/);
});

test("weights sum to one, respect the cap, and go to cash when risk is off or unmeasured", () => {
  const rows = [{ symbol: "A", vol20: 0.1 }, { symbol: "B", vol20: 0.2 }, { symbol: "C", vol20: 0.4 }, { symbol: "D", vol20: 0.8 }];
  const config = { weighting: "inverse_vol", maxWeight: 0.35 };
  const weights = targetWeights(rows, { riskOn: true }, config);
  assert.ok(Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-6);
  assert.ok(Math.max(...Object.values(weights)) <= 0.35 + 1e-9);
  assert.ok(weights.A > weights.D, "calmer names get more weight");
  assert.deepEqual(targetWeights(rows, { riskOn: false }, config), {});
  assert.deepEqual(targetWeights(rows, { riskOn: null }, config), {}, "no benchmark means no regime, not risk-on");
});

test("bear regime holds cash", () => {
  const result = rankRotation(universe(420, { spyDrift: -0.002 }), { requireTrend: false });
  assert.equal(result.regime.riskOn, false);
  assert.deepEqual(result.targets, {});
  assert.equal(result.cashWeight, 1);
});

test("rebalance orders sell first and close dropped names", () => {
  const orders = rebalanceOrders({ AAA: 0.5, BBB: 0.5 }, { BBB: 0.5, CCC: 0.5 }, 10_000, { AAA: 10, BBB: 20, CCC: 25 });
  assert.deepEqual(orders.map((order) => [order.symbol, order.side]), [["AAA", "sell"], ["CCC", "buy"]]);
  assert.equal(orders[0].closesPosition, true);
  assert.equal(orders[1].quantity, 200);
});

test("backtest fills at the next open, never on the decision bar, and rotates through many names", () => {
  const bars = universe(520);
  const result = runRotationBacktest(bars, { rebalanceEvery: 10, rotation: { topN: 4, requireTrend: false } });
  const firstDecision = result.rebalances[0].time;
  const firstTrade = result.trades[0];
  assert.ok(firstTrade.time > firstDecision, "the first fill is after the first decision");
  const fillBar = bars[firstTrade.symbol].find((bar) => bar.time === firstTrade.time);
  assert.ok(Math.abs(firstTrade.price - fillBar.open * 1.0005) < 1e-6, "buys fill at the open plus slippage");
  assert.equal(result.equityCurve.length, 520 - (ROTATION_MIN_BARS - 1));
  assert.equal(result.benchmarkCurve.length, result.equityCurve.length);
  assert.ok(new Set(result.trades.map((trade) => trade.symbol)).size > 4);
  assert.ok(Number.isFinite(result.metrics.strategy.returnPercent));
  assert.ok(Number.isFinite(result.metrics.SPY.returnPercent));
  assert.equal(result.metrics.cash.returnPercent, 0);
});

test("a rebalance decided on the final bar is reported unfilled, not filled at an invented price", () => {
  const length = (ROTATION_MIN_BARS - 1) + 1 + 10 * 3; // last day is a rebalance day
  const result = runRotationBacktest(universe(length), { rebalanceEvery: 10, rotation: { requireTrend: false } });
  assert.ok(result.unfilledRebalance);
  assert.equal(result.unfilledRebalance.time, result.end);
  assert.ok(result.trades.every((trade) => trade.time <= result.end));
});

test("service reports fetch failures instead of inventing bars", async () => {
  const bars = universe();
  const service = createRotationService({
    universe: [...NAMES, "MISSING"],
    market: {
      getBars: async (symbol) => {
        if (!bars[symbol]) throw new Error(`Unknown symbol: ${symbol}`);
        return { symbol, interval: "1day", source: "fixture", bars: bars[symbol] };
      }
    }
  });
  const result = await service.screen({ requireTrend: false });
  assert.equal(result.available, true);
  assert.deepEqual(result.errors.map((error) => error.symbol), ["MISSING"]);
  assert.equal(result.scored, NAMES.length + 1);
  assert.ok(result.survivorshipWarning.length > 0);
  assert.ok(result.rows.every((row) => Array.isArray(row.spark)));
  assert.equal(result.regimeSeries.length, 260);
});

test("service declines to rank without the benchmark", async () => {
  const service = createRotationService({ universe: ["AAPL"], market: { getBars: async () => { throw new Error("provider unconfigured"); } } });
  const result = await service.screen();
  assert.equal(result.available, false);
  assert.match(result.reason, /SPY/);
});

test("the rotation-momentum strategy enters an uptrend and exits when it breaks", async () => {
  const { loadAlgorithmRegistry } = await import("../../server/algorithms/registry.js");
  const { runBacktest } = await import("../../server/engine/backtest.js");
  const registry = await loadAlgorithmRegistry({ algorithmsDir: new URL("../../algorithms", import.meta.url).pathname });
  const strategy = registry.algorithms.find((entry) => entry.id === "rotation-momentum");
  assert.ok(strategy, "rotation-momentum is a bundled strategy");
  const rise = series("AAPL", 360, { drift: 0.0015, vol: 0.012, seed: 11 }).bars;
  const fallFrom = rise.at(-1).close;
  const fall = series("AAPL", 80, { drift: -0.006, vol: 0.01, seed: 12, start: fallFrom }).bars
    .map((bar, index) => ({ ...bar, time: rise.at(-1).time + (index + 1) * DAY }));
  const result = runBacktest({ bars: [...rise, ...fall], algorithm: strategy.algorithm, interval: "1day" });
  const buy = result.trades.find((trade) => trade.side === "buy");
  assert.ok(buy, "it buys during the uptrend");
  assert.ok(buy.signalIndex >= 252, "it waits for 12-1 momentum history");
  assert.equal(buy.fillIndex, buy.signalIndex + 1, "fills at the next open");
  assert.ok(result.trades.some((trade) => trade.side === "sell" && /50-day mean|Trailing stop/.test(trade.rule ?? "")), "exits carry their reason");
  assert.ok(result.trades.every((trade) => trade.side !== "buy" || trade.signalIndex < rise.length), "no new entries once the trend has broken");
  assert.equal(result.metrics.openPosition, false, "flat through the decline");
});
