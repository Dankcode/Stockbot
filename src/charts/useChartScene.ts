import * as React from "react";

import {
  aggregateBarsToPixels,
  computeExtrema,
  nearestTimeIndex,
  selectTimeTicks,
  toTimestamp
} from "./model.js";
import { createChartLayout, createNumericScale, formatEquityMultiple, formatPrice, xForIndex } from "./scales";
import type { AggregatedChartBar } from "./model.js";
import type {
  ChartBar,
  ChartEquityPoint,
  ChartEquitySeries,
  ChartRiskEvent,
  ChartTime,
  ChartTrade,
  ChartViewport
} from "./types";

export type CandleGeometry = {
  bar: AggregatedChartBar;
  sourceBar: ChartBar;
  x: number;
  bodyWidth: number;
  openY: number;
  closeY: number;
  highY: number;
  lowY: number;
  volumeY: number;
  volumeHeight: number;
  positive: boolean;
};

export type ScenePath = {
  id: string;
  label: string;
  path: string;
  seriesIndex?: number;
  kind?: ChartEquitySeries["kind"];
};

export type ChartScene = {
  empty: boolean;
  axisMode: "price" | "equity";
  renderer: "svg" | "canvas";
  layout: ReturnType<typeof createChartLayout>;
  viewport: ChartViewport;
  visibleItemCount: number;
  candles: readonly CandleGeometry[];
  timeTicks: readonly { x: number; label: string; time: ChartTime }[];
  valueTicks: readonly { y: number; label: string; value: number }[];
  currentValue: { y: number; label: string } | null;
  movingAveragePath: string;
  vwapPath: string;
  upperBandPath: string;
  lowerBandPath: string;
  equityPaths: readonly ScenePath[];
  trades: readonly { trade: ChartTrade; x: number; y: number }[];
  riskEvents: readonly { event: ChartRiskEvent; x: number; y: number | null }[];
  nearestCandleAtX: (x: number) => CandleGeometry | null;
  timeAtX: (x: number) => ChartTime | null;
  priceAtY: (y: number) => number | null;
  equityAtTime: (time: ChartTime) => Readonly<Record<string, number>>;
};

type SceneOptions = {
  bars: readonly ChartBar[];
  trades: readonly ChartTrade[];
  riskEvents: readonly ChartRiskEvent[];
  equitySeries: readonly ChartEquitySeries[];
  viewport: ChartViewport;
  width: number;
  height: number;
  interval: string;
  showVolume: boolean;
  movingAverage: number | false;
  showVwap: boolean;
  showBands: boolean;
  logScale: boolean;
  minBarWidth: number;
  canvasThreshold: number;
};

function linePath(points: readonly { x: number; y: number }[]) {
  return points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function visibleTimeRange(timeline: readonly { time: ChartTime }[], viewport: ChartViewport) {
  const first = timeline[viewport.startIndex];
  const last = timeline[Math.max(viewport.startIndex, viewport.endIndex - 1)];
  return {
    firstTime: first?.time ?? null,
    lastTime: last?.time ?? null,
    firstTimestamp: first ? toTimestamp(first.time) : Number.NaN,
    lastTimestamp: last ? toTimestamp(last.time) : Number.NaN
  };
}

function pointWithinRange(
  point: { time: ChartTime },
  firstTime: ChartTime | null,
  lastTime: ChartTime | null,
  firstTimestamp: number,
  lastTimestamp: number
) {
  const timestamp = toTimestamp(point.time);
  if (Number.isFinite(timestamp) && Number.isFinite(firstTimestamp) && Number.isFinite(lastTimestamp)) {
    return timestamp >= firstTimestamp && timestamp <= lastTimestamp;
  }
  return firstTime === null || lastTime === null || String(point.time) >= String(firstTime) && String(point.time) <= String(lastTime);
}

function normalizedEquitySeries(
  series: readonly ChartEquitySeries[],
  range: ReturnType<typeof visibleTimeRange>
) {
  return series
    .filter((item) => item.visible !== false && item.points.length > 0)
    .map((item) => {
      const baseline = item.points[0]?.equity;
      const points = item.points
        .filter((point) => pointWithinRange(point, range.firstTime, range.lastTime, range.firstTimestamp, range.lastTimestamp))
        .filter((point) => Number.isFinite(point.equity) && Number.isFinite(baseline) && baseline !== 0)
        .map((point) => ({ ...point, normalized: point.equity / baseline }));
      return { ...item, points };
    })
    .filter((item) => item.points.length > 0);
}

function projectedXForTime(
  time: ChartTime,
  timeline: readonly { time: ChartTime }[],
  viewport: ChartViewport,
  plotLeft: number,
  plotWidth: number
) {
  const index = nearestTimeIndex(timeline, time);
  const visibleCount = Math.max(1, viewport.endIndex - viewport.startIndex);
  const relative = Math.max(0, Math.min(visibleCount - 1, index - viewport.startIndex));
  return plotLeft + ((relative + 0.5) / visibleCount) * plotWidth;
}

function movingAverageValues(
  bars: readonly ChartBar[],
  buckets: readonly AggregatedChartBar[],
  viewport: ChartViewport,
  window: number
) {
  if (!buckets.length || window <= 1) {
    return [];
  }
  const targets = new Set(buckets.map((bucket) => bucket.sourceIndex));
  const start = Math.max(0, viewport.startIndex - window + 1);
  const values = new Map<number, number>();
  const queue: number[] = [];
  let sum = 0;
  for (let index = start; index < viewport.endIndex; index += 1) {
    const close = bars[index]?.close;
    if (!Number.isFinite(close)) continue;
    queue.push(close);
    sum += close;
    if (queue.length > window) {
      sum -= queue.shift() ?? 0;
    }
    if (targets.has(index)) {
      values.set(index, sum / queue.length);
    }
  }
  return buckets.map((bucket) => values.get(bucket.sourceIndex) ?? bucket.close);
}

function rollingBandValues(buckets: readonly AggregatedChartBar[], window: number) {
  const upper: number[] = [];
  const lower: number[] = [];
  const sample: number[] = [];
  let sum = 0;
  let sumSquares = 0;
  for (const bucket of buckets) {
    sample.push(bucket.close);
    sum += bucket.close;
    sumSquares += bucket.close * bucket.close;
    if (sample.length > window) {
      const removed = sample.shift() ?? 0;
      sum -= removed;
      sumSquares -= removed * removed;
    }
    const mean = sum / sample.length;
    const variance = Math.max(0, sumSquares / sample.length - mean * mean);
    const deviation = Math.sqrt(variance) * 2;
    upper.push(mean + deviation);
    lower.push(mean - deviation);
  }
  return { upper, lower };
}

function sceneFromOptions(options: SceneOptions): ChartScene {
  const {
    bars,
    trades,
    riskEvents,
    equitySeries,
    viewport,
    width,
    height,
    interval,
    showVolume,
    movingAverage,
    showVwap,
    showBands,
    logScale,
    minBarWidth,
    canvasThreshold
  } = options;
  const visibleEquitySeries = equitySeries.filter((series) => series.visible !== false && series.points.length > 0);
  const longestEquity = visibleEquitySeries.reduce<readonly ChartEquityPoint[]>(
    (longest, series) => (series.points.length > longest.length ? series.points : longest),
    []
  );
  const timeline: readonly { time: ChartTime }[] = bars.length > 0 ? bars : longestEquity;
  const layout = createChartLayout(width, height, showVolume && bars.length > 0);
  const range = visibleTimeRange(timeline, viewport);
  const normalizedSeries = normalizedEquitySeries(visibleEquitySeries, range);
  const buckets = bars.length
    ? aggregateBarsToPixels(bars, viewport, layout.plotWidth, minBarWidth)
    : [];
  const extrema = computeExtrema(buckets);
  const equityValues = normalizedSeries.flatMap((series) => series.points.map((point) => point.normalized));
  let equityMinimum = Number.POSITIVE_INFINITY;
  let equityMaximum = Number.NEGATIVE_INFINITY;
  for (const value of equityValues) {
    if (value < equityMinimum) equityMinimum = value;
    if (value > equityMaximum) equityMaximum = value;
  }
  if (!Number.isFinite(equityMinimum) || !Number.isFinite(equityMaximum)) {
    equityMinimum = 0.99;
    equityMaximum = 1.01;
  }
  if (equityMinimum === equityMaximum) {
    equityMinimum -= 0.01;
    equityMaximum += 0.01;
  }

  const axisMode: ChartScene["axisMode"] = extrema ? "price" : "equity";
  const valueScale = extrema
    ? createNumericScale(extrema.low, extrema.high, layout.plotTop, layout.plotBottom, logScale)
    : createNumericScale(equityMinimum, equityMaximum, layout.plotTop, layout.plotBottom, false);
  const equityScale = createNumericScale(equityMinimum, equityMaximum, layout.plotTop, layout.plotBottom, false);
  const step = buckets.length ? layout.plotWidth / buckets.length : 0;
  const bodyWidth = Math.max(1, Math.min(12, step * 0.64));
  const candles: CandleGeometry[] = buckets.map((bar, index) => {
    const volumeHeight = extrema && showVolume && layout.volumeHeight > 0
      ? Math.max(1, (bar.volume / Math.max(extrema.maxVolume, 1)) * layout.volumeHeight)
      : 0;
    return {
      bar,
      sourceBar: bars[bar.sourceIndex] ?? bar,
      x: xForIndex(index, buckets.length, layout),
      bodyWidth,
      openY: valueScale.project(bar.open),
      closeY: valueScale.project(bar.close),
      highY: valueScale.project(bar.high),
      lowY: valueScale.project(bar.low),
      volumeY: layout.volumeTop + layout.volumeHeight - volumeHeight,
      volumeHeight,
      positive: bar.close >= bar.open
    };
  });

  const tickItems = buckets.length ? buckets : timeline.slice(viewport.startIndex, viewport.endIndex);
  const timeTicks = selectTimeTicks(tickItems, layout.plotWidth, interval).map((tick) => ({
    x: xForIndex(tick.itemIndex, tickItems.length, layout),
    label: tick.label,
    time: tick.time
  }));
  const valueTicks = valueScale.ticks.map((value) => ({
    y: valueScale.project(value),
    value,
    label: axisMode === "price" ? formatPrice(value) : formatEquityMultiple(value)
  }));

  const averageWindow = movingAverage === false ? 0 : Math.max(2, Math.round(movingAverage));
  const averageValues = averageWindow ? movingAverageValues(bars, buckets, viewport, averageWindow) : [];
  const movingAveragePath = linePath(
    averageValues.map((value, index) => ({ x: candles[index]?.x ?? 0, y: valueScale.project(value) }))
  );

  let cumulativeValue = 0;
  let cumulativeVolume = 0;
  const vwapValues = buckets.map((bucket) => {
    const typical = (bucket.high + bucket.low + bucket.close) / 3;
    cumulativeValue += typical * bucket.volume;
    cumulativeVolume += bucket.volume;
    return cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : typical;
  });
  const vwapPath = showVwap
    ? linePath(vwapValues.map((value, index) => ({ x: candles[index]?.x ?? 0, y: valueScale.project(value) })))
    : "";
  const bandValues = showBands ? rollingBandValues(buckets, Math.max(5, averageWindow || 20)) : { upper: [], lower: [] };
  const upperBandPath = showBands
    ? linePath(bandValues.upper.map((value, index) => ({ x: candles[index]?.x ?? 0, y: valueScale.project(value) })))
    : "";
  const lowerBandPath = showBands
    ? linePath(bandValues.lower.map((value, index) => ({ x: candles[index]?.x ?? 0, y: valueScale.project(value) })))
    : "";

  const equityPaths = normalizedSeries.map<ScenePath>((series, seriesIndex) => ({
    id: series.id,
    label: series.label,
    kind: series.kind,
    seriesIndex,
    path: linePath(
      series.points.map((point) => ({
        x: projectedXForTime(point.time, timeline, viewport, layout.plotLeft, layout.plotWidth),
        y: equityScale.project(point.normalized)
      }))
    )
  }));

  const visibleTrades = trades
    .filter((trade) => pointWithinRange(trade, range.firstTime, range.lastTime, range.firstTimestamp, range.lastTimestamp))
    .map((trade) => {
      const bucketIndex = nearestTimeIndex(buckets, trade.time);
      const bucket = buckets[bucketIndex];
      const x = bucket ? candles[bucketIndex].x : projectedXForTime(trade.time, timeline, viewport, layout.plotLeft, layout.plotWidth);
      const price = trade.price ?? bucket?.close ?? (axisMode === "equity" ? 1 : valueScale.minimum);
      return { trade, x, y: axisMode === "price" ? valueScale.project(price) : layout.plotBottom };
    });
  const visibleRiskEvents = riskEvents
    .filter((event) => pointWithinRange(event, range.firstTime, range.lastTime, range.firstTimestamp, range.lastTimestamp))
    .map((event) => ({
      event,
      x: projectedXForTime(event.time, timeline, viewport, layout.plotLeft, layout.plotWidth),
      y: event.price !== undefined && axisMode === "price" ? valueScale.project(event.price) : null
    }));

  const lastCandle = candles[candles.length - 1];
  const firstNormalizedSeries = normalizedSeries[0];
  const lastEquity = firstNormalizedSeries?.points[firstNormalizedSeries.points.length - 1]?.normalized;
  const currentValue = lastCandle
    ? { y: lastCandle.closeY, label: formatPrice(lastCandle.bar.close) }
    : lastEquity !== undefined
      ? { y: equityScale.project(lastEquity), label: formatEquityMultiple(lastEquity) }
      : null;
  const visibleItemCount = Math.max(0, viewport.endIndex - viewport.startIndex);

  return {
    empty: timeline.length === 0,
    axisMode,
    renderer: bars.length > 0 && visibleItemCount > canvasThreshold ? "canvas" : "svg",
    layout,
    viewport,
    visibleItemCount,
    candles,
    timeTicks,
    valueTicks,
    currentValue,
    movingAveragePath,
    vwapPath,
    upperBandPath,
    lowerBandPath,
    equityPaths,
    trades: visibleTrades,
    riskEvents: visibleRiskEvents,
    nearestCandleAtX: (x) => {
      if (!candles.length || x < layout.plotLeft || x > layout.plotRight) {
        return null;
      }
      const index = Math.max(0, Math.min(candles.length - 1, Math.floor(((x - layout.plotLeft) / layout.plotWidth) * candles.length)));
      return candles[index] ?? null;
    },
    timeAtX: (x) => {
      if (!timeline.length || x < layout.plotLeft || x > layout.plotRight) {
        return null;
      }
      const relativeIndex = Math.max(
        0,
        Math.min(visibleItemCount - 1, Math.floor(((x - layout.plotLeft) / layout.plotWidth) * visibleItemCount))
      );
      return timeline[viewport.startIndex + relativeIndex]?.time ?? null;
    },
    priceAtY: (y) => axisMode === "price" ? valueScale.invert(y) : null,
    equityAtTime: (time) => Object.fromEntries(
      normalizedSeries.map((series) => {
        const index = nearestTimeIndex(series.points, time);
        return [series.id, index >= 0 ? series.points[index].normalized : Number.NaN];
      })
    )
  };
}

export function useChartScene(options: SceneOptions) {
  return React.useMemo(
    () => sceneFromOptions(options),
    [
      options.bars,
      options.canvasThreshold,
      options.equitySeries,
      options.height,
      options.interval,
      options.logScale,
      options.minBarWidth,
      options.movingAverage,
      options.riskEvents,
      options.showBands,
      options.showVolume,
      options.showVwap,
      options.trades,
      options.viewport.endIndex,
      options.viewport.startIndex,
      options.width
    ]
  );
}
