import * as React from "react";

import type { CandleGeometry } from "../useChartScene";

export const SvgCandles = React.memo(function SvgCandles({ candles }: { candles: readonly CandleGeometry[] }) {
  return (
    <g aria-hidden="true" className="stockbot-chart-candles">
      {candles.map((candle) => {
        const bodyTop = Math.min(candle.openY, candle.closeY);
        const bodyHeight = Math.max(1, Math.abs(candle.closeY - candle.openY));
        return (
          <g
            className={candle.positive ? "stockbot-chart-candle is-up" : "stockbot-chart-candle is-down"}
            key={`${String(candle.bar.time)}-${candle.bar.sourceStart}`}
          >
            {candle.volumeHeight > 0 ? (
              <rect
                className="stockbot-chart-volume"
                height={candle.volumeHeight}
                width={candle.bodyWidth}
                x={candle.x - candle.bodyWidth / 2}
                y={candle.volumeY}
              />
            ) : null}
            <line className="stockbot-chart-wick" x1={candle.x} x2={candle.x} y1={candle.highY} y2={candle.lowY} />
            <rect
              className="stockbot-chart-body"
              height={bodyHeight}
              width={candle.bodyWidth}
              x={candle.x - candle.bodyWidth / 2}
              y={bodyTop}
            />
          </g>
        );
      })}
    </g>
  );
});

