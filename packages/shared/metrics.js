const NULL_LABEL = "—";

function defineMetric(definition) {
  return Object.freeze(definition);
}

/**
 * Canonical presentation and comparison semantics for every session metric.
 * Percentage values are percentage points (12.5 means 12.5%), while money is
 * stored in integer minor units (12345 means $123.45).
 */
export const METRIC_DEFINITIONS = Object.freeze({
  returnPercent: defineMetric({
    key: "returnPercent",
    label: "Return",
    unit: "percent",
    precision: 2,
    signed: true,
    signConvention: "signed",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  finalEquity: defineMetric({
    key: "finalEquity",
    label: "Final equity",
    unit: "money",
    precision: 2,
    signed: false,
    signConvention: "nonnegative",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  maxDrawdown: defineMetric({
    key: "maxDrawdown",
    label: "Max drawdown",
    unit: "percent",
    precision: 2,
    signed: false,
    signConvention: "positive-magnitude",
    higherIsBetter: false,
    nullLabel: NULL_LABEL
  }),
  sharpe: defineMetric({
    key: "sharpe",
    label: "Sharpe",
    unit: "ratio",
    precision: 2,
    signed: false,
    signConvention: "signed",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  sortino: defineMetric({
    key: "sortino",
    label: "Sortino",
    unit: "ratio",
    precision: 2,
    signed: false,
    signConvention: "signed",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  profitFactor: defineMetric({
    key: "profitFactor",
    label: "Profit factor",
    unit: "ratio",
    precision: 2,
    signed: false,
    signConvention: "nonnegative",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  winRate: defineMetric({
    key: "winRate",
    label: "Win rate",
    unit: "percent",
    precision: 1,
    signed: false,
    signConvention: "nonnegative",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  tradeCount: defineMetric({
    key: "tradeCount",
    label: "Trades",
    unit: "count",
    precision: 0,
    signed: false,
    signConvention: "nonnegative",
    higherIsBetter: null,
    nullLabel: NULL_LABEL
  }),
  exposurePercent: defineMetric({
    key: "exposurePercent",
    label: "Exposure",
    unit: "percent",
    precision: 1,
    signed: false,
    signConvention: "nonnegative",
    higherIsBetter: null,
    nullLabel: NULL_LABEL
  }),
  avgTradePercent: defineMetric({
    key: "avgTradePercent",
    label: "Average trade",
    unit: "percent",
    precision: 2,
    signed: true,
    signConvention: "signed",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  dayChange: defineMetric({
    key: "dayChange",
    label: "Day P&L",
    unit: "money",
    precision: 2,
    signed: true,
    signConvention: "signed",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  }),
  realizedPnl: defineMetric({
    key: "realizedPnl",
    label: "Realized P&L",
    unit: "money",
    precision: 2,
    signed: true,
    signConvention: "signed",
    higherIsBetter: true,
    nullLabel: NULL_LABEL
  })
});

/** @deprecated Prefer the uppercase constant in new code. */
export const metricRegistry = METRIC_DEFINITIONS;

export const METRIC_KEYS = Object.freeze(Object.keys(METRIC_DEFINITIONS));

export function isMetricKey(key) {
  return typeof key === "string" && Object.hasOwn(METRIC_DEFINITIONS, key);
}

export function getMetricDefinition(key) {
  if (!isMetricKey(key)) {
    throw new RangeError(`Unknown metric key: ${String(key)}`);
  }
  return METRIC_DEFINITIONS[key];
}

/**
 * Compares two values using the registry's direction. Returns 1 when the left
 * value wins, -1 when the right value wins, 0 for a tie, and null when the
 * metric is neutral or either value is unavailable.
 */
export function compareMetricValues(key, left, right) {
  const definition = getMetricDefinition(key);
  if (
    definition.higherIsBetter === null ||
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    return null;
  }
  if (left === right) {
    return 0;
  }
  const leftIsBetter = definition.higherIsBetter ? left > right : left < right;
  return leftIsBetter ? 1 : -1;
}
