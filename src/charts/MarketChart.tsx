import * as React from "react";

import { ChartCanvas } from "./ChartCanvas";
import { ChartInteraction } from "./ChartInteraction";
import { toTimestamp } from "./model.js";
import { useChartScene } from "./useChartScene";
import { useViewport } from "./useViewport";
import type {
  ChartBar,
  ChartEquitySeries,
  ChartRiskEvent,
  ChartTrade,
  MarketChartProps
} from "./types";
import "./chart.css";

const EMPTY_TRADES: readonly ChartTrade[] = [];
const EMPTY_RISK_EVENTS: readonly ChartRiskEvent[] = [];
const EMPTY_EQUITY_SERIES: readonly ChartEquitySeries[] = [];

function useElementWidth(elementRef: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = React.useState(720);

  React.useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const update = () => setWidth((current) => {
      const next = Math.max(280, Math.round(element.getBoundingClientRect().width));
      return current === next ? current : next;
    });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef]);

  return width;
}

function replayTime(
  bars: readonly ChartBar[],
  equitySeries: readonly ChartEquitySeries[],
  replayIndex: number | undefined
) {
  if (replayIndex === undefined) return null;
  if (bars.length) {
    return bars[Math.max(0, Math.min(bars.length - 1, replayIndex))]?.time ?? null;
  }
  const longest = equitySeries.reduce<readonly { time: string | number }[]>(
    (current, series) => series.points.length > current.length ? series.points : current,
    []
  );
  return longest[Math.max(0, Math.min(longest.length - 1, replayIndex))]?.time ?? null;
}

function truncateEquitySeries(
  series: readonly ChartEquitySeries[],
  index: number | undefined,
  cutoffTime: string | number | null
) {
  if (index === undefined) return series;
  const cutoff = cutoffTime === null ? Number.NaN : toTimestamp(cutoffTime);
  return series.map((item) => ({
    ...item,
    points: Number.isFinite(cutoff)
      ? item.points.filter((point) => {
          const timestamp = toTimestamp(point.time);
          return !Number.isFinite(timestamp) || timestamp <= cutoff;
        })
      : item.points.slice(0, Math.max(0, index + 1))
  }));
}

export const MarketChart = React.memo(function MarketChart({
  bars,
  trades = EMPTY_TRADES,
  riskEvents = EMPTY_RISK_EVENTS,
  equitySeries = EMPTY_EQUITY_SERIES,
  range = "",
  interval = "",
  height = 420,
  className = "",
  ariaLabel,
  viewport: controlledViewport,
  defaultViewport,
  initialVisibleBars = 120,
  onViewportChange,
  replayIndex,
  showVolume = true,
  movingAverage = false,
  showVwap = false,
  showBands = false,
  logScale: controlledLogScale,
  defaultLogScale = false,
  onLogScaleChange,
  minBarWidth = 2,
  canvasThreshold = 1_500,
  onBarSelect,
  onHoverChange
}: MarketChartProps) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(rootRef);
  const chartHeight = Math.max(320, height);
  const cutoffTime = React.useMemo(
    () => replayTime(bars, equitySeries, replayIndex),
    [bars, equitySeries, replayIndex]
  );
  const activeBars = React.useMemo(
    () => replayIndex === undefined ? bars : bars.slice(0, Math.max(0, Math.min(bars.length, replayIndex + 1))),
    [bars, replayIndex]
  );
  const activeEquitySeries = React.useMemo(
    () => truncateEquitySeries(equitySeries, replayIndex, cutoffTime),
    [cutoffTime, equitySeries, replayIndex]
  );
  const equityLength = activeEquitySeries.reduce((maximum, series) => Math.max(maximum, series.points.length), 0);
  const dataLength = activeBars.length || equityLength;
  const { viewport, zoomAt, panBy, reset } = useViewport({
    length: dataLength,
    viewport: controlledViewport,
    defaultViewport,
    initialVisible: initialVisibleBars,
    minimumVisible: Math.min(8, Math.max(1, dataLength)),
    onChange: onViewportChange
  });
  const [internalLogScale, setInternalLogScale] = React.useState(defaultLogScale);
  const logScale = controlledLogScale ?? internalLogScale;
  const setLogScale = React.useCallback((enabled: boolean) => {
    if (controlledLogScale === undefined) {
      setInternalLogScale(enabled);
    }
    onLogScaleChange?.(enabled);
  }, [controlledLogScale, onLogScaleChange]);
  const scene = useChartScene({
    bars: activeBars,
    trades,
    riskEvents,
    equitySeries: activeEquitySeries,
    viewport,
    width,
    height: chartHeight,
    interval,
    showVolume,
    movingAverage,
    showVwap,
    showBands,
    logScale,
    minBarWidth,
    canvasThreshold
  });
  const label = ariaLabel || [range, interval, bars.length ? "market chart" : "equity chart"].filter(Boolean).join(" ");

  return (
    <section className={`stockbot-market-chart ${className}`.trim()} ref={rootRef}>
      <header className="stockbot-chart-toolbar">
        <div className="stockbot-chart-context">
          {range ? <strong>{range}</strong> : null}
          {interval ? <span>{interval}</span> : null}
          <span>{scene.visibleItemCount.toLocaleString()} points</span>
        </div>
        <div className="stockbot-chart-actions">
          <button onClick={reset} type="button">Reset view</button>
          <button
            aria-pressed={logScale}
            className={logScale ? "is-active" : ""}
            disabled={!activeBars.length}
            onClick={() => setLogScale(!logScale)}
            type="button"
          >
            Log
          </button>
        </div>
      </header>

      {activeEquitySeries.length ? (
        <div aria-label="Chart series" className="stockbot-chart-legend">
          {activeEquitySeries.filter((series) => series.visible !== false).map((series, index) => (
            <span className={`stockbot-chart-series-${index % 6 + 1}`} key={series.id}>
              <i />
              {series.label}
            </span>
          ))}
        </div>
      ) : null}

      <div className="stockbot-chart-stage" style={{ height: chartHeight }}>
        {scene.empty ? (
          <div className="stockbot-chart-empty" role="status">No chart data available.</div>
        ) : (
          <>
            <ChartCanvas scene={scene} />
            <ChartInteraction
              ariaLabel={label || "Interactive market chart"}
              onBarSelect={onBarSelect}
              onHoverChange={onHoverChange}
              onPanBy={panBy}
              onZoomAt={zoomAt}
              scene={scene}
            />
          </>
        )}
      </div>
      <div className="stockbot-chart-renderer-status" aria-hidden="true">
        {scene.renderer === "canvas" ? "Canvas candles" : "SVG candles"}
      </div>
    </section>
  );
});
