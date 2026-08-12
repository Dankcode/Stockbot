import type { MetricKey } from "./metrics.js";

export interface CommonFormatOptions {
  locale?: string;
  nullLabel?: string;
}

export interface MoneyFormatOptions extends CommonFormatOptions {
  compact?: boolean;
  currency?: string;
  precision?: number;
  signed?: boolean;
}

export interface PercentFormatOptions extends CommonFormatOptions {
  precision?: number;
  signed?: boolean;
}

export interface QuantityFormatOptions extends CommonFormatOptions {
  maximumFractionDigits?: number;
}

export interface VolumeFormatOptions extends CommonFormatOptions {
  compact?: boolean;
  precision?: number;
}

export interface TimeFormatOptions extends CommonFormatOptions {
  timeZone?: string;
}

export interface MetricFormatOptions {
  compact?: boolean;
  currency?: string;
  locale?: string;
  precision?: number;
}

export type FormattableNumber = number | null | undefined;

export function formatMoney(cents: FormattableNumber, options?: MoneyFormatOptions): string;
export function formatPercent(value: FormattableNumber, options?: PercentFormatOptions): string;
export function formatQty(microShares: FormattableNumber, options?: QuantityFormatOptions): string;
export function formatVolume(value: FormattableNumber, options?: VolumeFormatOptions): string;
export function formatTime(epochMs: FormattableNumber, interval: string, options?: TimeFormatOptions): string;
export function formatMetric(key: MetricKey | string, value: FormattableNumber, options?: MetricFormatOptions): string;
