import assert from "node:assert/strict";
import test from "node:test";

import algorithm from "../../algorithms/trend-pullback.js";
import { validateAlgorithm } from "../../server/algorithms/validator.js";
import { runBacktest } from "../../server/engine/backtest.js";
import { deterministicBars } from "./fixtures/bars.js";

test("trend pullback validates and produces an executable, cost-aware result", () => {
  validateAlgorithm(algorithm, { file: "trend-pullback.js" });
  const result = runBacktest({
    bars: deterministicBars,
    algorithm,
    params: { fastPeriod: 9, slowPeriod: 20, maxHoldBars: 12, atrTrailMultiple: 2 },
    interval: "1day",
    fillModel: { slippageBps: 5, fixedCommission: 1, perShareCommission: 0.001 }
  });

  assert.ok(result.trades.length >= 1);
  assert.ok(Number.isFinite(result.metrics.returnPercent));
  assert.ok(result.trades.every((trade) => trade.fillIndex === trade.signalIndex + 1));
});
