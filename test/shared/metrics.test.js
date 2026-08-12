import test from "node:test";
import assert from "node:assert/strict";

import {
  METRIC_DEFINITIONS,
  METRIC_KEYS,
  compareMetricValues,
  getMetricDefinition,
  isMetricKey,
  metricRegistry
} from "../../packages/shared/metrics.js";

test("metric registry is canonical, immutable, and includes null semantics", () => {
  assert.equal(metricRegistry, METRIC_DEFINITIONS);
  assert.ok(Object.isFrozen(METRIC_DEFINITIONS));
  assert.ok(Object.isFrozen(METRIC_DEFINITIONS.maxDrawdown));
  assert.ok(METRIC_KEYS.includes("profitFactor"));
  assert.equal(METRIC_DEFINITIONS.profitFactor.nullLabel, "—");
  assert.equal(METRIC_DEFINITIONS.winRate.nullLabel, "—");
});

test("drawdown is a positive magnitude where lower wins", () => {
  const drawdown = getMetricDefinition("maxDrawdown");
  assert.equal(drawdown.signConvention, "positive-magnitude");
  assert.equal(drawdown.higherIsBetter, false);
  assert.equal(compareMetricValues("maxDrawdown", 4.2, 8.1), 1);
  assert.equal(compareMetricValues("maxDrawdown", 8.1, 4.2), -1);
});

test("metric comparison handles higher-is-better, ties, neutral, and missing values", () => {
  assert.equal(compareMetricValues("returnPercent", 3, 2), 1);
  assert.equal(compareMetricValues("returnPercent", 2, 2), 0);
  assert.equal(compareMetricValues("returnPercent", null, 2), null);
  assert.equal(compareMetricValues("tradeCount", 3, 2), null);
  assert.equal(isMetricKey("sharpe"), true);
  assert.equal(isMetricKey("bogus"), false);
  assert.throws(() => getMetricDefinition("bogus"), /Unknown metric key/);
});
