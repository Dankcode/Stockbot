import test from "node:test";
import assert from "node:assert/strict";

import {
  formatMetric,
  formatMoney,
  formatPercent,
  formatQty,
  formatTime,
  formatVolume
} from "../../packages/shared/format.js";
import {
  BAR_INTERVAL_DEFINITIONS,
  CHART_RANGES,
  RANGE_CONFIG,
  getAnnualizationFactor,
  getAnnualizationPeriods,
  getRangeConfig,
  normalizeBarInterval
} from "../../packages/shared/ranges.js";

test("integer units format consistently and preserve unavailable values", () => {
  assert.equal(formatMoney(1_234_567), "$12,345.67");
  assert.equal(formatMoney(1_234_567, { compact: true }), "$12.3K");
  assert.equal(formatPercent(12.345, { signed: true }), "+12.35%");
  assert.equal(formatQty(1_500_000), "1.5");
  assert.equal(formatVolume(1_652_100), "1.65M");
  assert.equal(formatMoney(null), "—");
  assert.equal(formatPercent(Number.NaN), "—");
});

test("formatMetric dispatches through registry semantics", () => {
  assert.equal(formatMetric("returnPercent", 12.345), "+12.35%");
  assert.equal(formatMetric("maxDrawdown", 4.1), "4.10%");
  assert.equal(formatMetric("dayChange", 12_345), "+$123.45");
  assert.equal(formatMetric("profitFactor", null), "—");
  assert.equal(formatMetric("winRate", null), "—");
  assert.throws(() => formatMetric("not-a-metric", 1), /Unknown metric key/);
});

test("time formatting changes with bar granularity", () => {
  const at = Date.UTC(2026, 7, 8, 14, 30);
  assert.match(formatTime(at, "5min", { timeZone: "UTC" }), /Aug 8/);
  assert.match(formatTime(at, "5min", { timeZone: "UTC" }), /02:30 PM/);
  assert.equal(formatTime(at, "1month", { timeZone: "UTC" }), "Aug 2026");
});

test("range config owns provider mappings and interval annualization", () => {
  const day = getRangeConfig("1d");
  assert.equal(day, RANGE_CONFIG["1D"]);
  assert.deepEqual(
    {
      interval: day.interval,
      lookbackDays: day.lookbackDays,
      limit: day.limit,
      alpacaTimeframe: day.alpacaTimeframe,
      polygonMultiplier: day.polygonMultiplier,
      polygonTimespan: day.polygonTimespan,
      finnhubResolution: day.finnhubResolution,
      periodsPerYear: day.periodsPerYear
    },
    {
      interval: "5min",
      lookbackDays: 7,
      limit: 78,
      alpacaTimeframe: "5Min",
      polygonMultiplier: 5,
      polygonTimespan: "minute",
      finnhubResolution: "5",
      periodsPerYear: 19_656
    }
  );
  assert.equal(CHART_RANGES.length, 7);
  assert.equal(BAR_INTERVAL_DEFINITIONS["1hour"].periodsPerYear, 1_638);
  assert.equal(getAnnualizationPeriods("1Hour"), 1_638);
  assert.equal(getAnnualizationFactor("1day"), Math.sqrt(252));
  assert.equal(normalizeBarInterval("60"), "1hour");
  assert.throws(() => getRangeConfig("2Y"), /Unknown chart range/);
});
