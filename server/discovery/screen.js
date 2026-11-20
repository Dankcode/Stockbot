/**
 * Screening rules for discovery: the quality gates, user filter rules and
 * named presets. The rule shape {metric, condition, value} and the three
 * quality heuristics follow Gunbot Quant's screener (MIT; see indicators.js).
 *
 * Rule values are in the units shown to the user: a return of +20% is written
 * 20, not 0.2. `scale` converts the stored metric into those units.
 */
import { z } from "zod";

export const METRICS = Object.freeze({
  price: { label: "Price", unit: "$", scale: 1, source: "price" },
  adv20: { label: "20-day average dollar volume", unit: "$", scale: 1, source: "price" },
  mom12m: { label: "12-month return", unit: "%", scale: 100, source: "price" },
  mom12_1: { label: "12-1 month momentum", unit: "%", scale: 100, source: "price" },
  mom6m: { label: "6-month return", unit: "%", scale: 100, source: "price" },
  mom3m: { label: "3-month return", unit: "%", scale: 100, source: "price" },
  fromHigh: { label: "Distance from 52-week high (0 = at the high)", unit: "%", scale: 100, source: "price" },
  vol1y: { label: "1-year volatility", unit: "%", scale: 100, source: "price" },
  maxDrawdown1y: { label: "Worst 1-year drawdown (negative)", unit: "%", scale: 100, source: "price" },
  rsi14: { label: "RSI(14)", unit: "", scale: 1, source: "price" },
  adx14: { label: "ADX(14) trend strength", unit: "", scale: 1, source: "price" },
  priceVsSma200Pct: { label: "Price vs 200-day average", unit: "%", scale: 1, source: "price" },
  atrPct14: { label: "ATR(14) as % of price", unit: "%", scale: 1, source: "price" },
  volatilityConsistency: { label: "Volatility consistency (std of daily ATR%, 90 days)", unit: "", scale: 1, source: "price" },
  maxDailySpikePct: { label: "Largest daily range, 90 days", unit: "%", scale: 1, source: "price" },
  volumeConcentrationPct: { label: "Volume on the 3 busiest days, 90 days", unit: "%", scale: 1, source: "price" },
  marketCapMillions: { label: "Market cap (USD millions)", unit: "$M", scale: 1, source: "fundamentals" },
  revenueGrowthTTM: { label: "Revenue growth, year over year", unit: "%", scale: 1, source: "fundamentals" },
  revenueGrowth3Y: { label: "Revenue growth, 3-year annual", unit: "%", scale: 1, source: "fundamentals" },
  epsGrowthTTM: { label: "EPS growth, year over year", unit: "%", scale: 1, source: "fundamentals" },
  grossMarginTTM: { label: "Gross margin", unit: "%", scale: 1, source: "fundamentals" },
  netMarginTTM: { label: "Net margin", unit: "%", scale: 1, source: "fundamentals" },
  roeTTM: { label: "Return on equity", unit: "%", scale: 1, source: "fundamentals" },
  debtToEquity: { label: "Debt / equity", unit: "", scale: 1, source: "fundamentals" },
  psTTM: { label: "Price / sales", unit: "", scale: 1, source: "fundamentals" },
  peTTM: { label: "Price / earnings", unit: "", scale: 1, source: "fundamentals" },
  beta: { label: "Beta", unit: "", scale: 1, source: "fundamentals" }
});

const metricKey = z.enum(Object.keys(METRICS));

export const FilterRuleSchema = z.object({
  metric: metricKey,
  condition: z.enum(["greater_than", "less_than", "between"]),
  value: z.union([z.number().finite(), z.tuple([z.number().finite(), z.number().finite()])])
}).strict().superRefine((rule, context) => {
  const range = Array.isArray(rule.value);
  if (rule.condition === "between" && !(range && rule.value[0] <= rule.value[1])) {
    context.addIssue({ code: "custom", path: ["value"], message: "between needs [low, high] with low <= high" });
  }
  if (rule.condition !== "between" && range) {
    context.addIssue({ code: "custom", path: ["value"], message: `${rule.condition} needs a single number` });
  }
});

export const QualityGatesSchema = z.object({
  enabled: z.boolean().default(true),
  maxVolatilityConsistency: z.number().positive().max(100).default(5),
  maxDailySpikePct: z.number().positive().max(1_000).default(40),
  maxVolumeConcentrationPct: z.number().positive().max(100).default(30)
}).strict();

export const QUALITY_GATES = Object.freeze([
  { key: "volatilityConsistency", param: "maxVolatilityConsistency", reason: "erratic volatility" },
  { key: "maxDailySpikePct", param: "maxDailySpikePct", reason: "extreme single-day move" },
  { key: "volumeConcentrationPct", param: "maxVolumeConcentrationPct", reason: "volume concentrated in a few days" }
]);

/**
 * Applies the quality gates. A stock fails a gate only when its value is
 * measured and at or above the limit; missing data is counted, not rejected.
 */
export function applyQualityGates(candidates, gates) {
  const stats = { enabled: gates.enabled, limits: Object.fromEntries(QUALITY_GATES.map((gate) => [gate.key, gates[gate.param]])), removed: {}, unmeasured: 0 };
  if (!gates.enabled) return { kept: candidates, stats };
  const kept = [];
  for (const candidate of candidates) {
    let failed = null;
    let unmeasured = false;
    for (const gate of QUALITY_GATES) {
      const value = candidate.inputs[gate.key];
      if (value === null || value === undefined) { unmeasured = true; continue; }
      if (value >= gates[gate.param]) { failed = gate.reason; break; }
    }
    if (failed) { stats.removed[failed] = (stats.removed[failed] ?? 0) + 1; continue; }
    if (unmeasured) stats.unmeasured += 1;
    kept.push(candidate);
  }
  return { kept, stats };
}

export function describeRule(rule) {
  const metric = METRICS[rule.metric];
  const unit = metric.unit === "%" ? "%" : metric.unit ? ` ${metric.unit}` : "";
  if (rule.condition === "between") return `${metric.label} between ${rule.value[0]}${unit} and ${rule.value[1]}${unit}`;
  return `${metric.label} ${rule.condition === "greater_than" ? ">" : "<"} ${rule.value}${unit}`;
}

function passes(rule, raw) {
  if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) return null;
  const value = Number(raw) * METRICS[rule.metric].scale;
  if (rule.condition === "greater_than") return value > rule.value;
  if (rule.condition === "less_than") return value < rule.value;
  return value >= rule.value[0] && value <= rule.value[1];
}

/**
 * Applies the filter rules whose metric comes from `source`. A stock without
 * the metric fails the rule (as in Gunbot Quant, which drops incomplete rows);
 * the count of those is reported separately so it is visible.
 */
export function applyFilterRules(candidates, rules, source) {
  const applied = [];
  let kept = candidates;
  for (const rule of rules) {
    if (METRICS[rule.metric].source !== source) continue;
    let removed = 0;
    let missing = 0;
    kept = kept.filter((candidate) => {
      const result = passes(rule, candidate.inputs[rule.metric]);
      if (result === null) { missing += 1; return false; }
      if (!result) removed += 1;
      return result;
    });
    applied.push({ rule: describeRule(rule), removed, missingData: missing, remaining: kept.length });
  }
  return { kept, applied };
}

/** Named starting points for the run form. Each is a partial set of run params. */
export const PRESETS = Object.freeze([
  {
    id: "balanced",
    name: "Balanced (default)",
    description: "Liquid stocks outside the S&P 500 above $300M, with the quality gates on. Rank by the growth or hold lens.",
    params: {}
  },
  {
    id: "strong-trends",
    name: "Strong trends",
    description: "Growth names already trending: ADX above 25, up more than 20% over six months, above the 200-day average.",
    params: { filters: [
      { metric: "adx14", condition: "greater_than", value: 25 },
      { metric: "mom6m", condition: "greater_than", value: 20 },
      { metric: "priceVsSma200Pct", condition: "greater_than", value: 0 }
    ] }
  },
  {
    id: "steady-compounders",
    name: "Steady compounders",
    description: "Hold candidates: volatility under 40%, worst drawdown no deeper than -30%, above the 200-day average.",
    params: { fundamentalsTop: 80, filters: [
      { metric: "vol1y", condition: "less_than", value: 40 },
      { metric: "maxDrawdown1y", condition: "greater_than", value: -30 },
      { metric: "priceVsSma200Pct", condition: "greater_than", value: 0 }
    ] }
  },
  {
    id: "small-mid-growth",
    name: "Small and mid-cap growth",
    description: "$300M to $10B, at least $5M a day traded, revenue growing more than 15% a year.",
    params: { minDollarVolume: 5_000_000, minMarketCapMillions: 300, maxMarketCapMillions: 10_000, fundamentalsTop: 100, filters: [
      { metric: "revenueGrowthTTM", condition: "greater_than", value: 15 }
    ] }
  },
  {
    id: "strict-quality",
    name: "Strict quality",
    description: "Tighter quality gates: no day wider than 25%, no more than 20% of volume on three days, steadier volatility.",
    params: { qualityGates: { enabled: true, maxVolatilityConsistency: 3, maxDailySpikePct: 25, maxVolumeConcentrationPct: 20 } }
  }
]);
