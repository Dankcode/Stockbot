export type BarInterval = "1min" | "5min" | "1hour" | "1day" | "1week" | "1month";
export type RangeKey = "1H" | "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";
export type TimeGranularity = "intraday" | "date" | "month";

export interface BarIntervalDefinition {
  readonly key: BarInterval;
  readonly label: string;
  readonly durationMs: number;
  readonly periodsPerTradingDay: number | null;
  readonly periodsPerYear: number;
  readonly timeGranularity: TimeGranularity;
}

export interface RangeDefinition {
  readonly key: RangeKey;
  readonly label: string;
  readonly lookbackDays: number;
  readonly interval: BarInterval;
  readonly limit: number;
  readonly alpacaTimeframe: "1Min" | "5Min" | "1Hour" | "1Day" | "1Week" | "1Month";
  readonly polygonMultiplier: number;
  readonly polygonTimespan: "minute" | "hour" | "day" | "week" | "month";
  readonly finnhubResolution: "1" | "5" | "60" | "D" | "W" | "M";
  readonly periodsPerYear: number;
}

export const BAR_INTERVAL_DEFINITIONS: Readonly<Record<BarInterval, BarIntervalDefinition>>;
export const BAR_INTERVALS: readonly BarInterval[];
export const RANGE_CONFIG: Readonly<Record<RangeKey, RangeDefinition>>;
export const RANGE_DEFINITIONS: Readonly<Record<RangeKey, RangeDefinition>>;
export const CHART_RANGES: readonly RangeDefinition[];
export const RANGE_KEYS: readonly RangeKey[];

export function isBarInterval(value: unknown): value is BarInterval;
export function normalizeBarInterval(value: string): BarInterval;
export function getBarIntervalDefinition(interval: string): BarIntervalDefinition;
export function isRangeKey(value: unknown): value is RangeKey;
export function getRangeConfig(range: string): RangeDefinition;
export function getRangeDefinition(range: string): RangeDefinition;
export function getAnnualizationPeriods(interval: string): number;
export function getAnnualizationFactor(interval: string): number;
