import assert from "node:assert/strict";
import test from "node:test";
import { runBacktest } from "../../server/engine/backtest.js";
import { calculateFill } from "../../server/engine/fill-model.js";
import { computeMetrics, maxDrawdownPercent } from "../../server/engine/metrics.js";
import { loadAlgorithmRegistry } from "../../server/algorithms/registry.js";
import { deterministicBars } from "./fixtures/bars.js";
import { bundledAlgorithmGolden } from "./fixtures/golden-results.js";

test("fill model applies adverse directional bps and fixed/per-share commission", () => {
  const model = { slippageBps: 100, fixedCommission: 1, perShareCommission: 0.05 };
  assert.deepEqual(calculateFill({ side: "buy", quantity: 10, referencePrice: 100 }, model), {
    side: "buy",
    quantity: 10,
    referencePrice: 100,
    price: 101,
    grossNotional: 1010,
    commission: 1.5,
    cashDelta: -1011.5,
    slippageCost: 10
  });
  assert.deepEqual(calculateFill({ side: "sell", quantity: 10, referencePrice: 100 }, model), {
    side: "sell",
    quantity: 10,
    referencePrice: 100,
    price: 99,
    grossNotional: 990,
    commission: 1.5,
    cashDelta: 988.5,
    slippageCost: 10
  });
});

test("signals become pending orders and fill only at the next bar open", () => {
  const algorithm = {
    name: "Fixture timing",
    signal: ({ index }) => (index === 2 ? "buy" : index === 4 ? "sell" : null)
  };
  const result = runBacktest({
    bars: deterministicBars.slice(0, 7),
    algorithm,
    startingCash: 1_000,
    positionFraction: 0.5,
    interval: "1day"
  });

  assert.equal(result.trades.length, 2);
  assert.deepEqual(
    result.trades.map(({ side, signalIndex, fillIndex, referencePrice, time }) => ({
      side,
      signalIndex,
      fillIndex,
      referencePrice,
      time
    })),
    [
      {
        side: "buy",
        signalIndex: 2,
        fillIndex: 3,
        referencePrice: deterministicBars[3].open,
        time: deterministicBars[3].time
      },
      {
        side: "sell",
        signalIndex: 4,
        fillIndex: 5,
        referencePrice: deterministicBars[5].open,
        time: deterministicBars[5].time
      }
    ]
  );
});

test("backtest routes both entries and exits through the shared fill model", () => {
  const result = runBacktest({
    bars: deterministicBars.slice(0, 5),
    algorithm: {
      name: "Costed round trip",
      signal: ({ index }) => (index === 1 ? "buy" : index === 2 ? "sell" : null)
    },
    startingCash: 1_000,
    positionFraction: 0.5,
    interval: "1day",
    fillModel: { slippageBps: 100, fixedCommission: 1, perShareCommission: 0.05 }
  });
  const [entry, exit] = result.trades;
  assert.equal(entry.referencePrice, deterministicBars[2].open);
  assert.equal(entry.price, Number((deterministicBars[2].open * 1.01).toFixed(10)));
  assert.equal(exit.referencePrice, deterministicBars[3].open);
  assert.equal(exit.price, Number((deterministicBars[3].open * 0.99).toFixed(10)));
  assert.ok(entry.commission > 1);
  assert.ok(exit.commission > 1);
  assert.ok(Math.abs(result.metrics.finalEquity - result.endingState.cash) < 0.000001);
});

test("each signal receives frozen, current-bar-bounded market and indicator views", () => {
  const observations = [];
  const algorithm = {
    name: "No look-ahead",
    signal({ index, bars, closes, indicators }) {
      observations.push({
        index,
        barsLength: bars.length,
        closesLength: closes.length,
        emaLength: indicators.ema(3).length,
        futureBar: bars[index + 1],
        futureClose: closes[index + 1],
        frozen: Object.isFrozen(bars) && Object.isFrozen(closes) && Object.isFrozen(indicators.ema(3))
      });
      return null;
    }
  };

  runBacktest({ bars: deterministicBars.slice(0, 8), algorithm, interval: "1day" });
  for (const observation of observations) {
    assert.equal(observation.barsLength, observation.index + 1);
    assert.equal(observation.closesLength, observation.index + 1);
    assert.equal(observation.emaLength, observation.index + 1);
    assert.equal(observation.futureBar, undefined);
    assert.equal(observation.futureClose, undefined);
    assert.equal(observation.frozen, true);
  }
});

test("a final-bar signal is reported but never filled", () => {
  const bars = deterministicBars.slice(0, 6);
  const result = runBacktest({
    bars,
    interval: "1day",
    algorithm: { name: "Late signal", signal: ({ index }) => (index === bars.length - 1 ? "buy" : null) }
  });
  assert.equal(result.trades.length, 0);
  assert.equal(result.lastSignal, "buy");
  assert.equal(result.unfilledSignal.action, "buy");
  assert.equal(result.unfilledSignal.signalIndex, bars.length - 1);
  assert.equal(result.endingState.position.qty, 0);
});

test("metrics use positive drawdown, interval-aware Sharpe, and nullable empty ratios", () => {
  const equityCurve = [100, 120, 90, 110].map((equity, index) => ({ time: String(index), equity }));
  assert.equal(maxDrawdownPercent(equityCurve), 25);

  const daily = computeMetrics({ equityCurve, trades: [], startingEquity: 100, interval: "1day" });
  const hourly = computeMetrics({ equityCurve, trades: [], startingEquity: 100, interval: "1hour" });
  assert.equal(daily.maxDrawdown, 25);
  assert.equal(daily.winRate, null);
  assert.equal(daily.profitFactor, null);
  assert.equal(typeof daily.sortino, "number");
  assert.notEqual(daily.sharpe, hourly.sharpe);
  assert.ok(Math.abs(hourly.sharpe) > Math.abs(daily.sharpe));
});

test("bundled algorithms load and match the deterministic golden results", async () => {
  const registry = await loadAlgorithmRegistry({ algorithmsDir: new URL("../../algorithms", import.meta.url).pathname });
  assert.deepEqual(registry.errors, []);
  assert.deepEqual(
    registry.algorithms.map((algorithm) => algorithm.id),
    ["donchian-breakout", "ema-momentum", "rsi-mean-reversion"]
  );

  for (const registered of registry.algorithms) {
    const result = runBacktest({ bars: deterministicBars, algorithm: registered.algorithm, interval: "1day" });
    const snapshot = {
      fills: result.trades.map(({ side, signalIndex, fillIndex, referencePrice }) => ({
        side,
        signalIndex,
        fillIndex,
        referencePrice
      })),
      metrics: result.metrics
    };
    assert.deepEqual(snapshot, bundledAlgorithmGolden[registered.id], registered.id);
  }
});
