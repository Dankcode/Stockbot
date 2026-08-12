import { getMetricDefinition } from "./metrics.js";
import { getBarIntervalDefinition } from "./ranges.js";

const DEFAULT_LOCALE = "en-US";
const DEFAULT_CURRENCY = "USD";
const DEFAULT_NULL_LABEL = "—";
const MICRO_SHARES_PER_SHARE = 1_000_000;

function finiteValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? (Object.is(numeric, -0) ? 0 : numeric) : null;
}

function signDisplay(signed) {
  return signed ? "exceptZero" : "auto";
}

export function formatMoney(cents, options = {}) {
  const {
    compact = false,
    currency = DEFAULT_CURRENCY,
    locale = DEFAULT_LOCALE,
    nullLabel = DEFAULT_NULL_LABEL,
    precision = compact ? 1 : 2,
    signed = false
  } = options;
  const value = finiteValue(cents);
  if (value === null) {
    return nullLabel;
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    minimumFractionDigits: compact ? 0 : precision,
    maximumFractionDigits: precision,
    signDisplay: signDisplay(signed)
  }).format(value / 100);
}

export function formatPercent(value, options = {}) {
  const {
    locale = DEFAULT_LOCALE,
    nullLabel = DEFAULT_NULL_LABEL,
    precision = 2,
    signed = false
  } = options;
  const numeric = finiteValue(value);
  if (numeric === null) {
    return nullLabel;
  }
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
    signDisplay: signDisplay(signed)
  }).format(numeric);
  return `${formatted}%`;
}

export function formatQty(microShares, options = {}) {
  const {
    locale = DEFAULT_LOCALE,
    nullLabel = DEFAULT_NULL_LABEL,
    maximumFractionDigits = 6
  } = options;
  const value = finiteValue(microShares);
  if (value === null) {
    return nullLabel;
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value / MICRO_SHARES_PER_SHARE);
}

export function formatVolume(value, options = {}) {
  const {
    compact = true,
    locale = DEFAULT_LOCALE,
    nullLabel = DEFAULT_NULL_LABEL,
    precision = 2
  } = options;
  const numeric = finiteValue(value);
  if (numeric === null) {
    return nullLabel;
  }
  return new Intl.NumberFormat(locale, {
    notation: compact ? "compact" : "standard",
    compactDisplay: "short",
    maximumFractionDigits: precision
  }).format(numeric);
}

export function formatTime(epochMs, interval, options = {}) {
  const value = finiteValue(epochMs);
  const { locale = DEFAULT_LOCALE, nullLabel = DEFAULT_NULL_LABEL, timeZone } = options;
  if (value === null) {
    return nullLabel;
  }
  const { timeGranularity } = getBarIntervalDefinition(interval);
  const dateOptions =
    timeGranularity === "intraday"
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : timeGranularity === "month"
        ? { year: "numeric", month: "short" }
        : { year: "numeric", month: "short", day: "numeric" };

  return new Intl.DateTimeFormat(locale, {
    ...dateOptions,
    ...(timeZone ? { timeZone } : {})
  }).format(new Date(value));
}

function formatRatio(value, definition, options) {
  const numeric = finiteValue(value);
  if (numeric === null) {
    return definition.nullLabel;
  }
  return new Intl.NumberFormat(options.locale ?? DEFAULT_LOCALE, {
    minimumFractionDigits: options.precision ?? definition.precision,
    maximumFractionDigits: options.precision ?? definition.precision,
    signDisplay: signDisplay(definition.signed)
  }).format(numeric);
}

function formatCount(value, definition, options) {
  const numeric = finiteValue(value);
  if (numeric === null) {
    return definition.nullLabel;
  }
  return new Intl.NumberFormat(options.locale ?? DEFAULT_LOCALE, {
    maximumFractionDigits: options.precision ?? definition.precision
  }).format(numeric);
}

export function formatMetric(key, value, options = {}) {
  const definition = getMetricDefinition(key);
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return definition.nullLabel;
  }
  const precision = options.precision ?? definition.precision;
  switch (definition.unit) {
    case "money":
      return formatMoney(value, {
        compact: options.compact,
        currency: options.currency,
        locale: options.locale,
        nullLabel: definition.nullLabel,
        precision,
        signed: definition.signed
      });
    case "percent":
      return formatPercent(value, {
        locale: options.locale,
        nullLabel: definition.nullLabel,
        precision,
        signed: definition.signed
      });
    case "ratio":
      return formatRatio(value, definition, { ...options, precision });
    case "count":
      return formatCount(value, definition, { ...options, precision });
    default:
      throw new TypeError(`Unsupported metric unit: ${definition.unit}`);
  }
}
