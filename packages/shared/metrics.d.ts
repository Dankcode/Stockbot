export type MetricKey =
  | "returnPercent"
  | "finalEquity"
  | "maxDrawdown"
  | "sharpe"
  | "sortino"
  | "profitFactor"
  | "winRate"
  | "tradeCount"
  | "exposurePercent"
  | "avgTradePercent"
  | "dayChange"
  | "realizedPnl";

export type MetricUnit = "money" | "percent" | "ratio" | "count";
export type MetricSignConvention = "signed" | "nonnegative" | "positive-magnitude";

export interface MetricDefinition {
  readonly key: MetricKey;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly precision: number;
  readonly signed: boolean;
  readonly signConvention: MetricSignConvention;
  readonly higherIsBetter: boolean | null;
  readonly nullLabel: string;
}

export const METRIC_DEFINITIONS: Readonly<Record<MetricKey, MetricDefinition>>;
/** @deprecated Prefer METRIC_DEFINITIONS in new code. */
export const metricRegistry: typeof METRIC_DEFINITIONS;
export const METRIC_KEYS: readonly MetricKey[];

export function isMetricKey(key: unknown): key is MetricKey;
export function getMetricDefinition(key: MetricKey | string): MetricDefinition;
export function compareMetricValues(
  key: MetricKey | string,
  left: number | null | undefined,
  right: number | null | undefined
): -1 | 0 | 1 | null;
