import assert from "node:assert/strict";
import test from "node:test";

import { ExpressionError, evaluate } from "../../server/plugins/expression.js";
import { runBacktest } from "../../server/engine/backtest.js";
import { compileMethod } from "../../server/plugins/method-engine.js";

function context(overrides = {}) {
  return {
    index: 4,
    series: { px: [10, 20, 30, 40, 50] },
    params: { lookback: 2 },
    constants: { derivedLookback: 3 },
    ...overrides
  };
}

test("series offsets preserve literal, parameterised, and derived lookbacks without look-ahead", () => {
  assert.equal(evaluate(context(), { series: { name: "px", offset: 1 } }), 40);
  assert.equal(evaluate(context(), { series: { name: "px", offset: { param: "lookback" } } }), 30);
  assert.equal(evaluate(context(), { series: { name: "px", offset: { const: "derivedLookback" } } }), 20);
  assert.ok(Number.isNaN(evaluate(context(), { series: { name: "px", offset: 5 } })), "a pre-window read must not wrap to the final bar");
});

for (const [label, offset] of [["fractional", 1.5], ["negative", -1], ["too-large", 513]]) {
  test(`series offset rejects ${label} values`, () => {
    assert.throws(
      () => evaluate(context(), { series: { name: "px", offset } }),
      (error) => error instanceof ExpressionError && error.code === "PLUGIN_EXPRESSION_INVALID" && error.message.includes("series offset must be an integer from 0 through 512")
    );
  });
}

test("a parameterised series offset reaches a compiled method and changes its backtest", () => {
  const algorithm = compileMethod({
    id: "offset-probe",
    params: { lookback: 1 },
    method: {
      kind: "rules.v1",
      warmup: { param: "lookback" },
      indicators: { px: { fn: "ema", period: 1 } },
      entry: [{ when: { gt: [{ bar: "close" }, { series: { name: "px", offset: { param: "lookback" } } }] } }],
      exit: [{ when: { lt: [{ bar: "close" }, { series: { name: "px", offset: { param: "lookback" } } }] } }]
    }
  });
  const closes = [100, 105, 110, 100, 101, 102, 103];
  const bars = closes.map((close, index) => ({ time: index * 86_400_000, open: close, high: close + 1, low: close - 1, close, volume: 1_000_000 }));
  const shortLookback = runBacktest({ bars, algorithm, params: { lookback: 1 } });
  const longLookback = runBacktest({ bars, algorithm, params: { lookback: 4 } });
  assert.notEqual(shortLookback.trades.length, longLookback.trades.length, "the sweep must change the compiled method's behaviour");
});
