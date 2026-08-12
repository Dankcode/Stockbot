import type { ChartBar, ChartTime, ChartViewport } from "./types";

export type AggregatedChartBar = ChartBar & {
  startTime: ChartTime;
  endTime: ChartTime;
  sourceStart: number;
  sourceEnd: number;
  sourceIndex: number;
};

export function toTimestamp(time: ChartTime): number;
export function clampViewport(viewport: ChartViewport | undefined, length: number, minimumVisible?: number): ChartViewport;
export function tailViewport(length: number, visibleCount?: number, minimumVisible?: number): ChartViewport;
export function zoomViewportAt(
  viewport: ChartViewport,
  length: number,
  anchorRatio: number,
  factor: number,
  minimumVisible?: number
): ChartViewport;
export function panViewport(
  viewport: ChartViewport,
  length: number,
  delta: number,
  minimumVisible?: number
): ChartViewport;
export function computeExtrema(bars: readonly ChartBar[]): {
  high: number;
  low: number;
  minPositive: number | null;
  maxVolume: number;
} | null;
export function aggregateBarsToPixels(
  bars: readonly ChartBar[],
  viewport: ChartViewport,
  pixelWidth: number,
  minimumBarWidth?: number
): AggregatedChartBar[];
export function formatTimeTick(time: ChartTime, interval?: string, spanMs?: number): string;
export function selectTimeTicks<T extends { time: ChartTime }>(
  items: readonly T[],
  pixelWidth: number,
  interval?: string,
  minimumSpacing?: number
): Array<{ itemIndex: number; time: ChartTime; label: string }>;
export function nearestTimeIndex<T extends { time: ChartTime }>(items: readonly T[], time: ChartTime): number;

