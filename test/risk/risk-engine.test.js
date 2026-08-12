import assert from "node:assert/strict";
import test from "node:test";
import { createRiskEngine } from "../../server/risk/engine.js";

test("risk sizing converts percentage stop to price distance", () => {
  const engine = createRiskEngine();
  const sized = engine.sizeOrder({ signal: "buy", price: 100, equity: 100_000, cash: 100_000, atr: 1, stopLossPercent: 5 });
  assert.equal(sized.stopDistance, 5);
  assert.equal(sized.riskBudget, 1_000);
  assert.equal(sized.qty, 200);
});

test("stale quotes and insufficient funds produce attributable blocks", () => {
  const engine = createRiskEngine({ rules: { marketHours: { enabled: false } } });
  const failures = engine.preTrade({
    now: 10_000,
    symbol: "AAPL",
    quote: { price: 100, at: 0 },
    priorPrice: 100,
    qty: 20,
    side: "buy",
    cash: 1_000,
    equity: 1_000,
    symbolNotional: 0,
    estimatedCommission: 1,
    hasPosition: false,
    openPositionCount: 0,
    ordersLastMinute: 0,
    ordersToday: 0
  });
  assert.deepEqual(new Set(failures.map((item) => item.ruleId)), new Set(["quote_freshness", "sufficient_funds", "max_symbol_exposure"]));
});

test("continuous loss and drawdown rules halt with observed values", () => {
  const engine = createRiskEngine();
  const verdicts = engine.continuous({
    now: 10_000,
    startingEquity: 100_000,
    equity: 89_000,
    peakEquity: 100_000,
    accountEquity: 89_000,
    accountPeakEquity: 100_000,
    positionValue: 10_000,
    latestQuoteAt: 10_000
  });
  assert.ok(verdicts.some((item) => item.ruleId === "max_daily_loss" && item.severity === "halt"));
  assert.ok(verdicts.some((item) => item.ruleId === "max_drawdown" && item.severity === "halt"));
});
