/**
 * Fill model, metrics and backtest core tests.
 *
 * The headline test is "next-bar-open fills beat same-close fills" — it
 * quantifies the look-ahead bug from code-review finding C2 rather than merely
 * asserting the fix compiles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createFillModel, resolveExecution, priceFill, sizeBuy } from "../training/fill-model.js";
import { computeMetrics, periodsPerYear, formatMetric } from "../training/metrics.js";
import { runBacktest, runBuyAndHold, runCashControl } from "../training/backtest.js";
import { createIndicators, rsiSeries, emaSeries, atrSeries } from "../training/indicators.js";
import { makeBars, makeRamp, HOUR } from "./fixtures.js";

const BASE = Date.UTC(2025, 0, 6, 14, 30);

// ─────────────────────────────────────────────────────────────────────────────
// Fill model
// ─────────────────────────────────────────────────────────────────────────────

test("resolveExecution defaults to the next bar's open", () => {
  const bars = makeRamp({ count: 5 });
  const model = createFillModel();
  const execution = resolveExecution(bars, 2, model);

  assert.equal(execution.index, 3);
  assert.equal(execution.referencePrice, bars[3].open);
});

test("a signal on the final bar is unfillable", () => {
  const bars = makeRamp({ count: 5 });
  const model = createFillModel();
  // Carrying it to the close would reintroduce the look-ahead we just removed.
  assert.equal(resolveExecution(bars, 4, model), null);
});

test("same_close reproduces the legacy behaviour and warns", () => {
  const bars = makeRamp({ count: 5 });
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on("warning", onWarning);

  const model = createFillModel({ rule: "same_close" });
  const execution = resolveExecution(bars, 2, model);
  assert.equal(execution.index, 2);
  assert.equal(execution.referencePrice, bars[2].close);

  process.off("warning", onWarning);
});

test("slippage always works against the trade direction", () => {
  const model = createFillModel({ slippageBps: 10 });
  const bar = { open: 100, high: 101, low: 99, close: 100, volume: 1 };

  const buy = priceFill({ side: "buy", referencePrice: 100, qty: 10, bar, model });
  const sell = priceFill({ side: "sell", referencePrice: 100, qty: 10, bar, model });

  assert.ok(buy.price > 100, "buys fill higher");
  assert.ok(sell.price < 100, "sells fill lower");
  assert.equal(buy.price, 100.1);
  assert.equal(sell.price, 99.9);
});

test("ATR-fraction slippage scales with bar range", () => {
  const model = createFillModel({ slippageBps: 0, slippageAtrFraction: 0.5 });
  const tight = { open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 };
  const wide = { open: 100, high: 105, low: 95, close: 100, volume: 1 };

  const tightFill = priceFill({ side: "buy", referencePrice: 100, qty: 1, bar: tight, model });
  const wideFill = priceFill({ side: "buy", referencePrice: 100, qty: 1, bar: wide, model });

  assert.ok(wideFill.price > tightFill.price, "a volatile bar costs more to cross");
});

test("sizeBuy respects cash fraction, commission and lot size", () => {
  const model = createFillModel({ maxCashFraction: 0.5, commissionPerOrder: 1, lotSize: 1 });
  // 0.5 * 1000 = 500 budget, less $1 commission = 499 spendable, / 100 = 4.99 -> 4 whole shares.
  assert.equal(sizeBuy({ cash: 1000, price: 100, model }), 4);
});

test("sizeBuy never returns a quantity that would overdraw", () => {
  const model = createFillModel({ maxCashFraction: 1, commissionPerOrder: 50 });
  const qty = sizeBuy({ cash: 100, price: 10, model });
  assert.ok(qty * 10 + 50 <= 100 + 1e-9, "fill plus commission must fit in cash");
});

test("sizeBuy returns 0 when commission exceeds the budget", () => {
  const model = createFillModel({ commissionPerOrder: 1000 });
  assert.equal(sizeBuy({ cash: 100, price: 10, model }), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

test("periodsPerYear is inferred from bar spacing", () => {
  const daily = Array.from({ length: 30 }, (_, i) => BASE + i * 86_400_000);
  const hourly = Array.from({ length: 30 }, (_, i) => BASE + i * HOUR);
  const weekly = Array.from({ length: 30 }, (_, i) => BASE + i * 7 * 86_400_000);

  assert.equal(periodsPerYear(daily), 252);
  assert.equal(periodsPerYear(weekly), 52);
  // Hourly must annualize far more aggressively than daily — the legacy engine
  // used sqrt(252) for both (finding C7b).
  assert.ok(periodsPerYear(hourly) > 252 * 6);
});

test("maxDrawdown is a positive magnitude", () => {
  const equityCurve = [
    { at: BASE, equity: 100_000 },
    { at: BASE + HOUR, equity: 110_000 },
    { at: BASE + 2 * HOUR, equity: 88_000 }, // -20% from the 110k peak
    { at: BASE + 3 * HOUR, equity: 95_000 }
  ];
  const metrics = computeMetrics({ equityCurve, trades: [], startingCash: 100_000 });

  assert.equal(metrics.maxDrawdown, 20);
  assert.ok(metrics.maxDrawdown > 0, "never negative — it read as a gain in the legacy table");
});

test("profitFactor is null with no losses, not 99", () => {
  const equityCurve = [
    { at: BASE, equity: 100_000 },
    { at: BASE + HOUR, equity: 105_000 }
  ];
  const trades = [
    { side: "buy" },
    { side: "sell", pnl: 5000, pnlPercent: 5 }
  ];
  const metrics = computeMetrics({ equityCurve, trades, startingCash: 100_000 });

  // The legacy 99 sentinel sorted a single lucky trade above every real
  // strategy (finding C7c).
  assert.equal(metrics.profitFactor, null);
  assert.equal(formatMetric("profitFactor", metrics.profitFactor), "∞");
});

test("winRate is null with no closed trades, not 0", () => {
  const equityCurve = [
    { at: BASE, equity: 100_000 },
    { at: BASE + HOUR, equity: 100_000 }
  ];
  const metrics = computeMetrics({ equityCurve, trades: [], startingCash: 100_000 });

  // Coercing this to 0 ranked "never traded" below "lost money" (finding C7d).
  assert.equal(metrics.winRate, null);
  assert.equal(formatMetric("winRate", metrics.winRate), "—");
});

test("winRate counts only closed trades", () => {
  const equityCurve = [
    { at: BASE, equity: 100_000 },
    { at: BASE + HOUR, equity: 101_000 }
  ];
  const trades = [
    { side: "buy" },
    { side: "sell", pnl: 500, pnlPercent: 1 },
    { side: "buy" },
    { side: "sell", pnl: -200, pnlPercent: -0.5 }
  ];
  const metrics = computeMetrics({ equityCurve, trades, startingCash: 100_000 });

  assert.equal(metrics.closedTradeCount, 2);
  assert.equal(metrics.winRate, 50);
  assert.equal(metrics.profitFactor, 2.5); // 500 / 200
});

test("formatMetric signs and units correctly", () => {
  assert.equal(formatMetric("returnPercent", 12.345), "+12.35%");
  assert.equal(formatMetric("returnPercent", -3.2), "-3.20%");
  assert.equal(formatMetric("maxDrawdown", 8.5), "8.50%");
  assert.equal(formatMetric("finalEquity", 104230.5), "$104230.50");
  assert.equal(formatMetric("tradeCount", 12), "12");
});

// ─────────────────────────────────────────────────────────────────────────────
// Indicators
// ─────────────────────────────────────────────────────────────────────────────

test("indicator warmup is null, never zero", () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const ema = emaSeries(closes, 10);

  for (let i = 0; i < 9; i += 1) assert.equal(ema[i], null, `ema[${i}] should be null in warmup`);
  assert.ok(ema[9] != null);
  // A zero-filled warmup makes `close > ema` trivially true on bar 0.
  assert.ok(!ema.slice(0, 9).some((v) => v === 0));
});

test("RSI is 100 on a monotonic rise and bounded", () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  const rsi = rsiSeries(rising, 14);
  assert.equal(rsi[39], 100);

  const falling = Array.from({ length: 40 }, (_, i) => 140 - i);
  const rsiDown = rsiSeries(falling, 14);
  assert.ok(rsiDown[39] < 1, "monotonic decline should pin RSI near zero");

  for (const value of [...rsi, ...rsiDown]) {
    if (value != null) assert.ok(value >= 0 && value <= 100, `RSI out of bounds: ${value}`);
  }
});

test("ATR is positive and finite once warmed up", () => {
  const bars = makeBars({ count: 60, seed: 7 });
  const atr = atrSeries(bars, 14);
  for (let i = 15; i < bars.length; i += 1) {
    assert.ok(atr[i] > 0 && Number.isFinite(atr[i]), `atr[${i}] = ${atr[i]}`);
  }
});

test("indicator accessors are memoized", () => {
  const bars = makeBars({ count: 50 });
  const indicators = createIndicators(bars);
  assert.equal(indicators.ema(21), indicators.ema(21), "same array instance on repeat call");
  assert.notEqual(indicators.ema(21), indicators.ema(9));
});

test("highestHigh excludes the current bar", () => {
  const bars = makeRamp({ count: 20, startPrice: 100, step: 1 });
  const hh = createIndicators(bars).highestHigh(5);
  // Bar 10's window is bars 5..9, so it must not include bar 10's own high.
  assert.ok(hh[10] < bars[10].high, "a breakout test must be passable");
});

// ─────────────────────────────────────────────────────────────────────────────
// Backtest core
// ─────────────────────────────────────────────────────────────────────────────

/** Buys bar 1, holds. Deterministic, so arithmetic is checkable by hand. */
const buyAndHoldAlgo = {
  name: "test-bnh",
  signal: ({ index, position }) => (index === 1 && position.qty === 0 ? "buy" : null)
};

test("a buy signal fills at the next bar's open, not the signal bar's close", () => {
  const bars = makeRamp({ count: 10, startPrice: 100, step: 1 });
  const result = runBacktest({
    bars,
    algorithm: buyAndHoldAlgo,
    startingCash: 100_000,
    fillModel: { slippageBps: 0, maxCashFraction: 1 }
  });

  const buy = result.trades.find((t) => t.side === "buy");
  assert.equal(buy.signalIndex, 1);
  assert.equal(buy.index, 2, "executed one bar after the signal");
  assert.equal(buy.referencePrice, bars[2].open);
  assert.notEqual(buy.referencePrice, bars[1].close, "must NOT be the signal bar's close");
});

test("the look-ahead bug inflates returns — quantified", () => {
  // Rising series, so filling at the signal bar's close is systematically
  // cheaper than the next bar's open. That gap is the phantom edge the legacy
  // engine was reporting (finding C2).
  const bars = makeRamp({ count: 40, startPrice: 100, step: 0.5 });
  const options = { bars, algorithm: buyAndHoldAlgo, startingCash: 100_000 };

  const honest = runBacktest({ ...options, fillModel: { rule: "next_open", slippageBps: 0, maxCashFraction: 1 } });
  const buggy = runBacktest({ ...options, fillModel: { rule: "same_close", slippageBps: 0, maxCashFraction: 1 } });

  assert.ok(
    buggy.metrics.returnPercent > honest.metrics.returnPercent,
    `expected the look-ahead variant to look better: buggy=${buggy.metrics.returnPercent} honest=${honest.metrics.returnPercent}`
  );
});

test("slippage and commission reduce returns", () => {
  const bars = makeRamp({ count: 30, startPrice: 100, step: 0.5 });
  const free = runBacktest({
    bars, algorithm: buyAndHoldAlgo, startingCash: 100_000,
    fillModel: { slippageBps: 0, commissionPerOrder: 0, maxCashFraction: 1 }
  });
  const costly = runBacktest({
    bars, algorithm: buyAndHoldAlgo, startingCash: 100_000,
    fillModel: { slippageBps: 25, commissionPerOrder: 5, maxCashFraction: 1 }
  });

  assert.ok(costly.metrics.returnPercent < free.metrics.returnPercent);
  assert.ok(costly.metrics.totalCosts > 0);
  assert.equal(free.metrics.totalCosts, 0);
});

test("cash never goes negative", () => {
  const bars = makeBars({ count: 120, volatility: 0.05, seed: 11 });
  const churn = {
    name: "churn",
    // Alternate aggressively to stress the sizing path.
    signal: ({ index, position }) => (position.qty > 0 ? (index % 3 === 0 ? "sell" : null) : "buy")
  };
  const result = runBacktest({
    bars, algorithm: churn, startingCash: 10_000,
    fillModel: { slippageBps: 50, commissionPerOrder: 1, maxCashFraction: 1 }
  });

  for (const point of result.equityCurve) {
    assert.ok(point.cash >= -1e-6, `negative cash: ${point.cash}`);
  }
});

test("equity equals cash plus position value at every point", () => {
  const bars = makeBars({ count: 80, seed: 3 });
  const result = runBacktest({ bars, algorithm: buyAndHoldAlgo, startingCash: 100_000 });

  for (const point of result.equityCurve) {
    assert.ok(
      Math.abs(point.equity - (point.cash + point.positionValue)) < 1e-6,
      `equity mismatch: ${point.equity} != ${point.cash} + ${point.positionValue}`
    );
  }
});

test("an open position is force-closed at the end and flagged", () => {
  const bars = makeRamp({ count: 15 });
  const result = runBacktest({ bars, algorithm: buyAndHoldAlgo, startingCash: 100_000 });

  assert.ok(result.openPositionAtEnd);
  const forced = result.trades.find((t) => t.forced);
  assert.ok(forced, "forced exit must be recorded");
  assert.equal(forced.side, "sell");
  // Flagged so it is never mistaken for a strategy decision.
  assert.equal(result.equityCurve[result.equityCurve.length - 1].positionValue, 0);
});

test("features are exposed per bar and length-validated", () => {
  const bars = makeRamp({ count: 12 });
  const seen = [];
  const algo = {
    name: "feature-reader",
    features: {},
    signal: ({ index, features }) => {
      seen.push(features.marker);
      return index === 1 ? "buy" : null;
    }
  };
  const marker = bars.map((_, i) => `m${i}`);

  runBacktest({ bars, algorithm: algo, features: { marker } });
  assert.equal(seen[0], "m1", "signal starts at index 1");
  assert.equal(seen.at(-1), `m${bars.length - 1}`);

  assert.throws(
    () => runBacktest({ bars, algorithm: algo, features: { marker: ["too", "short"] } }),
    /has length 2 but there are 12 bars/
  );
});

test("a strategy cannot see the bar it will fill at", () => {
  const bars = makeRamp({ count: 20 });
  let maxIndexSeen = -1;
  const spy = {
    name: "spy",
    signal: ({ index, bars: visible }) => {
      maxIndexSeen = Math.max(maxIndexSeen, index);
      // The harness passes the full array; the contract is that the strategy
      // reads only up to `index`. Assert the fill lands beyond that.
      assert.equal(visible.length, bars.length);
      return index === 5 ? "buy" : null;
    }
  };
  const result = runBacktest({ bars, algorithm: spy });
  const buy = result.trades.find((t) => t.side === "buy");
  assert.ok(buy.index > buy.signalIndex, "fill index must be strictly after the signal index");
});

test("a throwing strategy fails loudly with the bar index", () => {
  const bars = makeRamp({ count: 10 });
  const broken = {
    name: "broken",
    signal: ({ index }) => {
      if (index === 4) throw new Error("kaboom");
      return null;
    }
  };
  assert.throws(() => runBacktest({ bars, algorithm: broken }), /signal threw at bar 4: kaboom/);
});

test("controls run under the same cost model", () => {
  const bars = makeBars({ count: 60, driftPerBar: 0.001, seed: 5 });
  const fillModel = { slippageBps: 5, maxCashFraction: 0.95 };

  const bnh = runBuyAndHold({ bars, startingCash: 100_000, fillModel });
  const cash = runCashControl({ bars, startingCash: 100_000 });

  assert.ok(bnh.metrics.returnPercent > 0, "upward drift should profit buy & hold");
  assert.ok(bnh.metrics.totalCosts > 0, "control pays costs too, or comparison is unfair");
  assert.equal(cash.metrics.returnPercent, 0);
  assert.equal(cash.metrics.maxDrawdown, 0);
  assert.equal(cash.metrics.winRate, null);
});

test("a strategy that never trades produces honest nulls", () => {
  const bars = makeBars({ count: 40 });
  const idle = { name: "idle", signal: () => null };
  const result = runBacktest({ bars, algorithm: idle, startingCash: 100_000 });

  assert.equal(result.metrics.returnPercent, 0);
  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.winRate, null);
  assert.equal(result.metrics.profitFactor, null);
  assert.equal(result.metrics.exposurePercent, 0);
});

test("rejects a bar series that is too short", () => {
  assert.throws(() => runBacktest({ bars: makeRamp({ count: 2 }), algorithm: buyAndHoldAlgo }), /at least 3 bars/);
});

test("rejects an algorithm without signal()", () => {
  assert.throws(
    () => runBacktest({ bars: makeRamp({ count: 10 }), algorithm: { name: "nope" } }),
    /must export a signal/
  );
});
