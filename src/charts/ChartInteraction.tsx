import * as React from "react";

import { formatPrice } from "./scales";
import type { ChartHover, ChartTime } from "./types";
import type { ChartScene } from "./useChartScene";

type InternalHover = ChartHover & { x: number; y: number };

type ChartInteractionProps = {
  scene: ChartScene;
  ariaLabel: string;
  onZoomAt: (anchorRatio: number, wheelDelta: number) => void;
  onPanBy: (bars: number) => void;
  onBarSelect?: (bar: NonNullable<ChartHover["bar"]>, index: number) => void;
  onHoverChange?: (hover: ChartHover | null) => void;
};

function formatHoverTime(time: ChartTime | null) {
  if (time === null) return "—";
  const date = new Date(time);
  return Number.isNaN(date.getTime())
    ? String(time)
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function publicHover(hover: InternalHover): ChartHover {
  return {
    bar: hover.bar,
    barIndex: hover.barIndex,
    time: hover.time,
    price: hover.price,
    equity: hover.equity
  };
}

function hoverAt(scene: ChartScene, x: number, y: number): InternalHover | null {
  const { layout } = scene;
  if (x < layout.plotLeft || x > layout.plotRight || y < layout.plotTop || y > layout.axisBottom) {
    return null;
  }
  const candle = scene.nearestCandleAtX(x);
  const time = candle?.sourceBar.time ?? scene.timeAtX(x);
  return {
    x,
    y,
    bar: candle?.sourceBar ?? null,
    barIndex: candle?.bar.sourceIndex ?? null,
    time,
    price: scene.priceAtY(y),
    equity: time === null ? {} : scene.equityAtTime(time)
  };
}

export const ChartInteraction = React.memo(function ChartInteraction({
  scene,
  ariaLabel,
  onZoomAt,
  onPanBy,
  onBarSelect,
  onHoverChange
}: ChartInteractionProps) {
  const [hover, setHover] = React.useState<InternalHover | null>(null);
  const hoverRef = React.useRef<InternalHover | null>(null);
  const callbacksRef = React.useRef({ onBarSelect, onHoverChange, onPanBy, onZoomAt });
  const dragRef = React.useRef<{ pointerId: number; startX: number; lastShift: number; moved: boolean } | null>(null);
  const descriptionId = React.useId();

  React.useEffect(() => {
    callbacksRef.current = { onBarSelect, onHoverChange, onPanBy, onZoomAt };
  }, [onBarSelect, onHoverChange, onPanBy, onZoomAt]);

  React.useEffect(() => {
    const current = hoverRef.current;
    if (!current) return;
    const next = hoverAt(scene, current.x, current.y);
    hoverRef.current = next;
    setHover(next);
    callbacksRef.current.onHoverChange?.(next ? publicHover(next) : null);
  }, [scene]);

  React.useEffect(() => () => callbacksRef.current.onHoverChange?.(null), []);

  const localPoint = React.useCallback((element: HTMLElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / Math.max(rect.width, 1)) * scene.layout.width,
      y: ((clientY - rect.top) / Math.max(rect.height, 1)) * scene.layout.height,
      rect
    };
  }, [scene.layout.height, scene.layout.width]);

  const updateHover = React.useCallback((element: HTMLElement, clientX: number, clientY: number) => {
    const point = localPoint(element, clientX, clientY);
    const next = hoverAt(scene, point.x, point.y);
    hoverRef.current = next;
    setHover(next);
    callbacksRef.current.onHoverChange?.(next ? publicHover(next) : null);
  }, [localPoint, scene]);

  const tooltipLines = hover
    ? [
        hover.bar ? `O ${formatPrice(hover.bar.open)}  H ${formatPrice(hover.bar.high)}` : null,
        hover.bar ? `L ${formatPrice(hover.bar.low)}  C ${formatPrice(hover.bar.close)}` : null,
        ...scene.equityPaths.map((series) => {
          const value = hover.equity[series.id];
          return Number.isFinite(value) ? `${series.label} ${value.toFixed(3)}×` : null;
        })
      ].filter((line): line is string => Boolean(line))
    : [];
  const tooltipHeight = 34 + tooltipLines.length * 17;
  const tooltipWidth = 196;
  const tooltipX = hover
    ? Math.min(
        Math.max(scene.layout.plotLeft + 6, hover.x + 12),
        Math.max(scene.layout.plotLeft + 6, scene.layout.plotRight - tooltipWidth - 6)
      )
    : 0;
  const tooltipY = hover
    ? Math.min(
        Math.max(scene.layout.plotTop + 6, hover.y - tooltipHeight - 12),
        Math.max(scene.layout.plotTop + 6, scene.layout.axisBottom - tooltipHeight - 6)
      )
    : 0;

  return (
    <div
      aria-describedby={descriptionId}
      aria-label={ariaLabel}
      className="stockbot-chart-interaction"
      onBlur={() => {
        if (!dragRef.current) {
          hoverRef.current = null;
          setHover(null);
          callbacksRef.current.onHoverChange?.(null);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          callbacksRef.current.onPanBy(direction * (event.shiftKey ? 10 : 1));
        } else if (event.key === "Enter" && hover?.bar && hover.barIndex !== null) {
          event.preventDefault();
          callbacksRef.current.onBarSelect?.(hover.bar, hover.barIndex);
        }
      }}
      onPointerCancel={(event) => {
        dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragRef.current = { pointerId: event.pointerId, startX: event.clientX, lastShift: 0, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        updateHover(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerLeave={() => {
        if (!dragRef.current) {
          hoverRef.current = null;
          setHover(null);
          callbacksRef.current.onHoverChange?.(null);
        }
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag) {
          const rect = event.currentTarget.getBoundingClientRect();
          const deltaPixels = event.clientX - drag.startX;
          const totalShift = -Math.round((deltaPixels / Math.max(rect.width, 1)) * scene.visibleItemCount);
          const incrementalShift = totalShift - drag.lastShift;
          if (incrementalShift !== 0) {
            drag.lastShift = totalShift;
            drag.moved = true;
            callbacksRef.current.onPanBy(incrementalShift);
          }
          return;
        }
        updateHover(event.currentTarget, event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        dragRef.current = null;
        if (!drag.moved && hoverRef.current?.bar && hoverRef.current.barIndex !== null) {
          callbacksRef.current.onBarSelect?.(hoverRef.current.bar, hoverRef.current.barIndex);
        }
      }}
      onWheel={(event) => {
        event.preventDefault();
        const point = localPoint(event.currentTarget, event.clientX, event.clientY);
        const anchor = (point.x - scene.layout.plotLeft) / Math.max(scene.layout.plotWidth, 1);
        callbacksRef.current.onZoomAt(Math.max(0, Math.min(1, anchor)), event.deltaY);
      }}
      role="group"
      tabIndex={0}
    >
      <span className="stockbot-chart-visually-hidden" id={descriptionId}>
        Use the mouse wheel to zoom at the cursor, drag to pan, and the left and right arrow keys to move through bars.
      </span>
      <svg
        aria-hidden="true"
        className="stockbot-chart-svg stockbot-chart-interaction-layer"
        preserveAspectRatio="none"
        viewBox={`0 0 ${scene.layout.width} ${scene.layout.height}`}
      >
        {hover ? (
          <g className="stockbot-chart-crosshair">
            <line x1={hover.x} x2={hover.x} y1={scene.layout.plotTop} y2={scene.layout.axisBottom} />
            <line x1={scene.layout.plotLeft} x2={scene.layout.plotRight} y1={hover.y} y2={hover.y} />
            <circle cx={hover.x} cy={hover.y} r="3" />
            <g className="stockbot-chart-tooltip" transform={`translate(${tooltipX} ${tooltipY})`}>
              <rect height={tooltipHeight} width={tooltipWidth} />
              <text className="stockbot-chart-tooltip-title" x="9" y="18">{formatHoverTime(hover.time)}</text>
              {tooltipLines.map((line, index) => (
                <text key={`${line}-${index}`} x="9" y={37 + index * 17}>{line}</text>
              ))}
            </g>
          </g>
        ) : null}
      </svg>
    </div>
  );
});
