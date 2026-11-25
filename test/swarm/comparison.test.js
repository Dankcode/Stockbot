import assert from "node:assert/strict";
import test from "node:test";

import { armMetrics, benchmarkReturn, maxDrawdown, sharpe } from "../../server/swarm/comparison.js";
import { nyInstant } from "../../server/swarm/calendar.js";
import { pnlBySymbol, roundTrips } from "../../server/swarm/trades.js";

const fill = (orderId, symbol, side, qtyShares, priceDollars, day, commission = 0) => ({
  orderId, symbol, side, qty: qtyShares * 1_000_000, price: priceDollars * 100, commission, filledAt: nyInstant(day, 11, 0)
});

test("FIFO round trips carry the entry features of the buy that opened them", () => {
  const fills = [
    fill("o1", "AAA", "buy", 10, 50, "2026-12-01"),
    fill("o2", "AAA", "buy", 10, 60, "2026-12-02"),
    fill("o3", "AAA", "sell", 15, 66, "2026-12-07"),
    fill("o4", "BBB", "buy", 5, 20, "2026-12-03")
  ];
  const intents = new Map([["o1", { entryFeaturesJson: { source: "discovery", lens: "growth", features: { mom6m: 0.5 } }, rationale: "first", score: 9 }],
    ["o2", { entryFeaturesJson: { source: "discovery", lens: "growth", features: { mom6m: 0.1 } }, rationale: "second", score: 8 }]]);
  const { closed, open } = roundTrips(fills, intents);
  assert.equal(closed.length, 2);
  assert.deepEqual(closed.map((trade) => [trade.qty / 1e6, trade.returnPct, trade.features.mom6m, trade.rationale]), [[10, 32, 0.5, "first"], [5, 10, 0.1, "second"]]);
  assert.equal(closed[0].pnlCents, 16_000, "10 shares × $16");
  assert.deepEqual(open.map((lot) => [lot.symbol, lot.qty / 1e6]), [["AAA", 5], ["BBB", 5]]);
});

test("P&L per symbol adds what is still held at its mark", () => {
  const fills = [fill("o1", "SPY", "buy", 10, 100, "2026-12-01", 50), fill("o2", "AAA", "buy", 10, 10, "2026-12-01"), fill("o3", "AAA", "sell", 10, 12, "2026-12-02")];
  const pnl = pnlBySymbol(fills, [{ symbol: "SPY", marketValue: 110_000 }]);
  assert.equal(pnl.get("SPY"), 110_000 - 100_000 - 50);
  assert.equal(pnl.get("AAA"), 2_000);
});

test("drawdown and Sharpe match hand arithmetic", () => {
  assert.equal(maxDrawdown(100, [110, 99, 120]), 99 / 110 - 1);
  assert.equal(sharpe([0.01, 0.01, 0.01, 0.01]), null, "fewer than 5 days");
  const returns = [0.01, -0.01, 0.01, -0.01, 0.01, -0.01];
  const mean = 0;
  assert.equal(sharpe(returns), mean);
});

test("an arm is measured against SPY and QQQ held from the close before its start", () => {
  const benchmarks = {
    SPY: [{ date: "2026-11-27", close: 500 }, { date: "2026-11-30", close: 505 }, { date: "2026-12-01", close: 510 }],
    QQQ: [{ date: "2026-11-27", close: 400 }, { date: "2026-12-01", close: 420 }]
  };
  assert.equal(benchmarkReturn(benchmarks.SPY, "2026-11-30", "2026-12-01"), 510 / 500 - 1);
  const arm = { id: "a", label: "disc-growth", kind: "agent", status: "active", startDate: "2026-11-30", startingCash: 10_000_000 };
  const snapshots = [
    { date: "2026-11-30", equity: 10_100_000, positionsJson: [] },
    { date: "2026-12-01", equity: 10_300_000, positionsJson: [{ symbol: "SPY", marketValue: 5_100_000 }] }
  ];
  const fills = [fill("o1", "SPY", "buy", 10_000, 5, "2026-11-30")];
  const metrics = armMetrics({ arm, snapshots, benchmarks, fills });
  assert.equal(metrics.returnPct, 3);
  assert.equal(metrics.spyReturnPct, 2);
  assert.equal(metrics.qqqReturnPct, 5);
  assert.equal(metrics.vsSpyPct, 1);
  assert.equal(metrics.vsQqqPct, -2);
  assert.equal(metrics.tradingDays, 2);
  assert.equal(metrics.tooEarlyToCall, true);
  assert.equal(metrics.pnlIndexCents, 5_100_000 - 5_000_000);
  assert.deepEqual(metrics.curve.map((point) => point.value), [1.01, 1.03]);
  assert.deepEqual(metrics.benchmarkCurves.SPY, [505 / 500, 510 / 500]);
});

test("60 trading days of snapshots stop the 'too early to call' label", () => {
  const arm = { id: "a", label: "x", kind: "agent", status: "active", startDate: "2026-01-02", startingCash: 100 };
  const snapshots = Array.from({ length: 60 }, (_, index) => ({ date: `2026-0${1 + Math.floor(index / 28)}-${String(1 + (index % 28)).padStart(2, "0")}`, equity: 100, positionsJson: [] }))
    .filter((row) => row.date >= "2026-01-02");
  assert.equal(armMetrics({ arm, snapshots: snapshots.slice(0, 59), benchmarks: {} }).tooEarlyToCall, true);
  const sixty = [...snapshots.slice(0, 59), { date: "2026-03-30", equity: 100, positionsJson: [] }];
  assert.equal(armMetrics({ arm, snapshots: sixty, benchmarks: {} }).tooEarlyToCall, false);
});
