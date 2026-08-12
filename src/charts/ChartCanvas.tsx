import * as React from "react";

import { StaticOverlays } from "./overlays/StaticOverlays";
import { CanvasCandles } from "./renderers/CanvasCandles";
import { SvgCandles } from "./renderers/SvgCandles";
import type { ChartScene } from "./useChartScene";

export const ChartCanvas = React.memo(function ChartCanvas({ scene }: { scene: ChartScene }) {
  const reactId = React.useId();
  const clipId = React.useMemo(() => `stockbot-chart-clip-${reactId.replace(/:/g, "")}`, [reactId]);
  const { layout } = scene;

  return (
    <div aria-hidden="true" className="stockbot-chart-static-scene">
      <svg
        className="stockbot-chart-svg stockbot-chart-grid-layer"
        preserveAspectRatio="none"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
      >
        <rect className="stockbot-chart-background" height={layout.height} width={layout.width} />
        <rect
          className="stockbot-chart-plot-background"
          height={layout.axisBottom - layout.plotTop}
          width={layout.plotWidth}
          x={layout.plotLeft}
          y={layout.plotTop}
        />
        {scene.valueTicks.map((tick) => (
          <line
            className="stockbot-chart-grid-line"
            key={`value-${tick.value}`}
            x1={layout.plotLeft}
            x2={layout.plotRight}
            y1={tick.y}
            y2={tick.y}
          />
        ))}
        {scene.timeTicks.map((tick, index) => (
          <line
            className="stockbot-chart-grid-line is-vertical"
            key={`time-${String(tick.time)}-${index}`}
            x1={tick.x}
            x2={tick.x}
            y1={layout.plotTop}
            y2={layout.axisBottom}
          />
        ))}
      </svg>

      {scene.renderer === "canvas" ? (
        <CanvasCandles scene={scene} />
      ) : (
        <svg
          className="stockbot-chart-svg stockbot-chart-candle-layer"
          preserveAspectRatio="none"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <SvgCandles candles={scene.candles} />
        </svg>
      )}
      <StaticOverlays clipId={clipId} scene={scene} />
    </div>
  );
});

