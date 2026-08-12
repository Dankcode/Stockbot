import * as React from "react";

import type { ChartScene } from "../useChartScene";

export const StaticOverlays = React.memo(function StaticOverlays({
  scene,
  clipId
}: {
  scene: ChartScene;
  clipId: string;
}) {
  const { layout } = scene;
  return (
    <svg
      aria-hidden="true"
      className="stockbot-chart-svg stockbot-chart-overlay-layer"
      preserveAspectRatio="none"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect
            height={layout.axisBottom - layout.plotTop}
            width={layout.plotWidth}
            x={layout.plotLeft}
            y={layout.plotTop}
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {scene.upperBandPath ? <path className="stockbot-chart-path is-band" d={scene.upperBandPath} /> : null}
        {scene.lowerBandPath ? <path className="stockbot-chart-path is-band" d={scene.lowerBandPath} /> : null}
        {scene.movingAveragePath ? <path className="stockbot-chart-path is-ma" d={scene.movingAveragePath} /> : null}
        {scene.vwapPath ? <path className="stockbot-chart-path is-vwap" d={scene.vwapPath} /> : null}
        {scene.equityPaths.map((series) => (
          <path
            className={`stockbot-chart-path is-equity stockbot-chart-series-${(series.seriesIndex ?? 0) % 6 + 1} is-${series.kind ?? "strategy"}`}
            d={series.path}
            key={series.id}
          />
        ))}
        {scene.riskEvents.map(({ event, x, y }) => (
          <g className={`stockbot-chart-risk is-${event.severity ?? "warn"}`} key={event.id}>
            <title>{event.label}</title>
            <line x1={x} x2={x} y1={layout.plotTop} y2={layout.axisBottom} />
            <path d={`M${x - 5},${(y ?? layout.plotTop + 8) - 5} h10 v10 h-10 z`} />
            <text textAnchor="middle" x={x} y={(y ?? layout.plotTop + 8) + 3}>
              {event.severity === "halt" ? "H" : event.severity === "block" ? "B" : event.severity === "info" ? "i" : "!"}
            </text>
          </g>
        ))}
        {scene.trades.map(({ trade, x, y }) => {
          const buy = trade.side === "buy";
          return (
            <g className={`stockbot-chart-trade is-${trade.side}`} key={trade.id}>
              <title>{trade.label ?? `${trade.side.toUpperCase()}${trade.reason ? ` — ${trade.reason}` : ""}`}</title>
              <path d={buy ? `M${x},${y - 10} L${x - 7},${y + 3} L${x + 7},${y + 3} Z` : `M${x},${y + 10} L${x - 7},${y - 3} L${x + 7},${y - 3} Z`} />
              <text textAnchor="middle" x={x} y={buy ? y + 17 : y - 9}>{buy ? "B" : "S"}</text>
            </g>
          );
        })}
      </g>

      {scene.currentValue ? (
        <g className="stockbot-chart-current-value">
          <line x1={layout.plotLeft} x2={layout.plotRight} y1={scene.currentValue.y} y2={scene.currentValue.y} />
          <rect height="22" width="64" x={layout.plotRight + 3} y={scene.currentValue.y - 11} />
          <text textAnchor="middle" x={layout.plotRight + 35} y={scene.currentValue.y + 4}>{scene.currentValue.label}</text>
        </g>
      ) : null}

      <g className="stockbot-chart-axis stockbot-chart-value-axis">
        {scene.valueTicks.map((tick) => (
          <text key={tick.value} x={layout.plotRight + 7} y={tick.y + 4}>{tick.label}</text>
        ))}
      </g>
      <g className="stockbot-chart-axis stockbot-chart-time-axis">
        {scene.timeTicks.map((tick, index) => (
          <text
            key={`${String(tick.time)}-${index}`}
            textAnchor={index === 0 ? "start" : index === scene.timeTicks.length - 1 ? "end" : "middle"}
            x={tick.x}
            y={layout.axisBottom + 21}
          >
            {tick.label}
          </text>
        ))}
      </g>
    </svg>
  );
});
