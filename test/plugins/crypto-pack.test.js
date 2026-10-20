import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAlgorithmRegistry } from "../../server/algorithms/registry.js";
import { EnginePool } from "../../server/engine/pool.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOUR = 3_600_000;
const START = Date.UTC(2026, 0, 5);

function barsFrom(closes) {
  return closes.map((close, index) => ({
    time: START + index * HOUR,
    open: index === 0 ? close : closes[index - 1],
    high: Math.max(close, index === 0 ? close : closes[index - 1]) + 25,
    low: Math.min(close, index === 0 ? close : closes[index - 1]) - 25,
    close,
    volume: 100 + index
  }));
}

/** Independent SMA so the test does not trust the engine's own indicator. */
function sma(closes, period, index) {
  if (index + 1 < period) return null;
  let sum = 0;
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) sum += closes[cursor];
  return sum / period;
}

function expectedCrosses(closes, fast, slow) {
  const crosses = [];
  for (let index = 1; index < closes.length; index += 1) {
    const [f0, s0, f1, s1] = [sma(closes, fast, index - 1), sma(closes, slow, index - 1), sma(closes, fast, index), sma(closes, slow, index)];
    if ([f0, s0, f1, s1].some((value) => value === null)) continue;
    if (f0 <= s0 && f1 > s1) crosses.push({ index, side: "buy" });
    if (f0 >= s0 && f1 < s1) crosses.push({ index, side: "sell" });
  }
  return crosses;
}

async function crossover(t) {
  const loaded = await loadAlgorithmRegistry({ algorithmsDir: path.join(ROOT, "algorithms"), pluginsDir: path.join(ROOT, "plugins") });
  assert.deepEqual(loaded.errors, []);
  const method = loaded.algorithms.find((algorithm) => algorithm.id === "crypto-pack/btc-sma-crossover");
  assert.ok(method, "the Bitcoin crossover method is registered");
  const pool = new EnginePool({ size: 1, timeoutMs: 5_000 });
  t.after(() => pool.close());
  return { method, pool };
}

test("Bitcoin SMA crossover buys on the cross above and sells on the cross back below", async (t) => {
  const { method, pool } = await crossover(t);
  assert.deepEqual(method.params, { fast: 20, slow: 50 });
  // Slide, rally, then slide again: exactly one cross up followed by one cross down.
  const closes = [
    ...Array.from({ length: 70 }, (_, index) => 60_000 - index * 80),
    ...Array.from({ length: 60 }, (_, index) => 54_400 + index * 220),
    ...Array.from({ length: 70 }, (_, index) => 67_600 - index * 260)
  ];
  const params = { fast: 20, slow: 50 };
  const expected = expectedCrosses(closes, params.fast, params.slow);
  assert.deepEqual(expected.map((cross) => cross.side), ["buy", "sell"], "fixture must contain exactly one round trip");

  const result = await pool.runBacktest({
    algorithmSource: method.source,
    filename: method.file,
    bars: barsFrom(closes),
    params,
    interval: "1hour",
    assetClass: "crypto",
    symbol: "BTCUSD",
    startingCash: 100_000
  });
  assert.deepEqual(
    result.trades.map((trade) => ({ index: trade.signalIndex, side: trade.side })),
    expected
  );
  // Next-bar fills: each order executes on the bar after its signal.
  for (const trade of result.trades) assert.equal(trade.fillIndex, trade.signalIndex + 1);
});

test("Bitcoin SMA crossover waits for a real cross instead of buying mid-trend", async (t) => {
  const { method, pool } = await crossover(t);
  const closes = Array.from({ length: 120 }, (_, index) => 50_000 + index * 150);
  const result = await pool.runBacktest({
    algorithmSource: method.source,
    filename: method.file,
    bars: barsFrom(closes),
    interval: "1hour",
    assetClass: "crypto",
    symbol: "BTCUSD",
    startingCash: 100_000
  });
  assert.equal(result.trades.length, 0);
});

test("a live evaluation of the newest closed bar reports the cross", async (t) => {
  const { method, pool } = await crossover(t);
  const closes = [
    ...Array.from({ length: 70 }, (_, index) => 60_000 - index * 80),
    ...Array.from({ length: 60 }, (_, index) => 54_400 + index * 220)
  ];
  const crossIndex = expectedCrosses(closes, 20, 50).find((cross) => cross.side === "buy").index;
  const evaluated = await pool.evaluateSignal({
    algorithmSource: method.source,
    filename: method.file,
    bars: barsFrom(closes.slice(0, crossIndex + 1)),
    params: { fast: 20, slow: 50 },
    position: { qty: 0, entryPrice: 0, entryIndex: -1 }
  });
  assert.equal(evaluated.signal?.action, "buy");
  const before = await pool.evaluateSignal({
    algorithmSource: method.source,
    filename: method.file,
    bars: barsFrom(closes.slice(0, crossIndex)),
    params: { fast: 20, slow: 50 },
    position: { qty: 0, entryPrice: 0, entryIndex: -1 }
  });
  assert.equal(before.signal, null);
});
