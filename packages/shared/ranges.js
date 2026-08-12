const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function freezeValues(record) {
  for (const value of Object.values(record)) {
    Object.freeze(value);
  }
  return Object.freeze(record);
}

/**
 * Annualization assumes the US equities calendar used by the current app:
 * 252 trading days and 390 trading minutes per day.
 */
export const BAR_INTERVAL_DEFINITIONS = freezeValues({
  "1min": {
    key: "1min",
    label: "1 min",
    durationMs: MINUTE_MS,
    periodsPerTradingDay: 390,
    periodsPerYear: 252 * 390,
    timeGranularity: "intraday"
  },
  "5min": {
    key: "5min",
    label: "5 min",
    durationMs: 5 * MINUTE_MS,
    periodsPerTradingDay: 78,
    periodsPerYear: 252 * 78,
    timeGranularity: "intraday"
  },
  "1hour": {
    key: "1hour",
    label: "1 hour",
    durationMs: 60 * MINUTE_MS,
    periodsPerTradingDay: 6.5,
    periodsPerYear: 252 * 6.5,
    timeGranularity: "intraday"
  },
  "1day": {
    key: "1day",
    label: "1 day",
    durationMs: DAY_MS,
    periodsPerTradingDay: 1,
    periodsPerYear: 252,
    timeGranularity: "date"
  },
  "1week": {
    key: "1week",
    label: "1 week",
    durationMs: 7 * DAY_MS,
    periodsPerTradingDay: null,
    periodsPerYear: 52,
    timeGranularity: "date"
  },
  "1month": {
    key: "1month",
    label: "1 month",
    durationMs: 2_629_746_000,
    periodsPerTradingDay: null,
    periodsPerYear: 12,
    timeGranularity: "month"
  }
});

export const BAR_INTERVALS = Object.freeze(Object.keys(BAR_INTERVAL_DEFINITIONS));

/**
 * The one range-to-query mapping used by charting and backtests. lookbackDays
 * deliberately includes provider/weekend buffer; limit is the maximum number
 * of normalized bars retained after fetching.
 */
export const RANGE_CONFIG = freezeValues({
  "1H": {
    key: "1H",
    label: "1H",
    lookbackDays: 3,
    interval: "1min",
    limit: 60,
    alpacaTimeframe: "1Min",
    polygonMultiplier: 1,
    polygonTimespan: "minute",
    finnhubResolution: "1",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["1min"].periodsPerYear
  },
  "1D": {
    key: "1D",
    label: "1D",
    lookbackDays: 7,
    interval: "5min",
    limit: 78,
    alpacaTimeframe: "5Min",
    polygonMultiplier: 5,
    polygonTimespan: "minute",
    finnhubResolution: "5",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["5min"].periodsPerYear
  },
  "1W": {
    key: "1W",
    label: "1W",
    lookbackDays: 14,
    interval: "1hour",
    limit: 180,
    alpacaTimeframe: "1Hour",
    polygonMultiplier: 1,
    polygonTimespan: "hour",
    finnhubResolution: "60",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["1hour"].periodsPerYear
  },
  "1M": {
    key: "1M",
    label: "1M",
    lookbackDays: 45,
    interval: "1day",
    limit: 60,
    alpacaTimeframe: "1Day",
    polygonMultiplier: 1,
    polygonTimespan: "day",
    finnhubResolution: "D",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["1day"].periodsPerYear
  },
  "3M": {
    key: "3M",
    label: "3M",
    lookbackDays: 120,
    interval: "1day",
    limit: 140,
    alpacaTimeframe: "1Day",
    polygonMultiplier: 1,
    polygonTimespan: "day",
    finnhubResolution: "D",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["1day"].periodsPerYear
  },
  "1Y": {
    key: "1Y",
    label: "1Y",
    lookbackDays: 420,
    interval: "1week",
    limit: 80,
    alpacaTimeframe: "1Week",
    polygonMultiplier: 1,
    polygonTimespan: "week",
    finnhubResolution: "W",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["1week"].periodsPerYear
  },
  ALL: {
    key: "ALL",
    label: "All",
    lookbackDays: 3650,
    interval: "1month",
    limit: 140,
    alpacaTimeframe: "1Month",
    polygonMultiplier: 1,
    polygonTimespan: "month",
    finnhubResolution: "M",
    periodsPerYear: BAR_INTERVAL_DEFINITIONS["1month"].periodsPerYear
  }
});

export const RANGE_DEFINITIONS = RANGE_CONFIG;
export const CHART_RANGES = Object.freeze(Object.values(RANGE_CONFIG));
export const RANGE_KEYS = Object.freeze(Object.keys(RANGE_CONFIG));

const INTERVAL_ALIASES = Object.freeze({
  "1min": "1min",
  "1Min": "1min",
  "1m": "1min",
  minute: "1min",
  "5min": "5min",
  "5Min": "5min",
  "5m": "5min",
  "1hour": "1hour",
  "1Hour": "1hour",
  "1h": "1hour",
  "60": "1hour",
  "1day": "1day",
  "1Day": "1day",
  "1d": "1day",
  D: "1day",
  "1week": "1week",
  "1Week": "1week",
  "1w": "1week",
  W: "1week",
  "1month": "1month",
  "1Month": "1month",
  "1mo": "1month",
  M: "1month"
});

export function isBarInterval(value) {
  return typeof value === "string" && Object.hasOwn(BAR_INTERVAL_DEFINITIONS, value);
}

export function normalizeBarInterval(value) {
  const normalized = typeof value === "string" ? INTERVAL_ALIASES[value.trim()] : undefined;
  if (!normalized) {
    throw new RangeError(`Unknown bar interval: ${String(value)}`);
  }
  return normalized;
}

export function getBarIntervalDefinition(interval) {
  return BAR_INTERVAL_DEFINITIONS[normalizeBarInterval(interval)];
}

export function isRangeKey(value) {
  return typeof value === "string" && Object.hasOwn(RANGE_CONFIG, value);
}

export function getRangeConfig(range) {
  const key = typeof range === "string" ? range.toUpperCase() : "";
  if (!Object.hasOwn(RANGE_CONFIG, key)) {
    throw new RangeError(`Unknown chart range: ${String(range)}`);
  }
  return RANGE_CONFIG[key];
}

export const getRangeDefinition = getRangeConfig;

export function getAnnualizationPeriods(interval) {
  return getBarIntervalDefinition(interval).periodsPerYear;
}

export function getAnnualizationFactor(interval) {
  return Math.sqrt(getAnnualizationPeriods(interval));
}
