import * as React from "react";

import { clampViewport, panViewport, tailViewport, zoomViewportAt } from "./model.js";
import type { ChartViewport } from "./types";

type ViewportOptions = {
  length: number;
  viewport?: ChartViewport;
  defaultViewport?: ChartViewport;
  initialVisible?: number;
  minimumVisible?: number;
  onChange?: (viewport: ChartViewport) => void;
};

export function useViewport({
  length,
  viewport: controlledViewport,
  defaultViewport,
  initialVisible = 120,
  minimumVisible = 8,
  onChange
}: ViewportOptions) {
  const [internalViewport, setInternalViewport] = React.useState<ChartViewport>(() =>
    clampViewport(defaultViewport ?? tailViewport(length, initialVisible, minimumVisible), length, minimumVisible)
  );
  const onChangeRef = React.useRef(onChange);
  const previousLengthRef = React.useRef(length);
  const current = clampViewport(controlledViewport ?? internalViewport, length, minimumVisible);
  const currentRef = React.useRef(current);

  React.useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  React.useEffect(() => {
    currentRef.current = current;
  }, [current.endIndex, current.startIndex]);

  React.useEffect(() => {
    const previousLength = previousLengthRef.current;
    previousLengthRef.current = length;
    if (controlledViewport) {
      return;
    }
    setInternalViewport((previous) => {
      const previousWidth = Math.max(minimumVisible, previous.endIndex - previous.startIndex);
      const followedTail = previous.endIndex >= previousLength;
      return followedTail
        ? tailViewport(length, previousLength === 0 ? initialVisible : previousWidth, minimumVisible)
        : clampViewport(previous, length, minimumVisible);
    });
  }, [controlledViewport, initialVisible, length, minimumVisible]);

  const setViewport = React.useCallback(
    (next: ChartViewport | ((current: ChartViewport) => ChartViewport)) => {
      const resolved = clampViewport(
        typeof next === "function" ? next(currentRef.current) : next,
        length,
        minimumVisible
      );
      currentRef.current = resolved;
      if (!controlledViewport) {
        setInternalViewport(resolved);
      }
      onChangeRef.current?.(resolved);
    },
    [controlledViewport, length, minimumVisible]
  );

  const zoomAt = React.useCallback(
    (anchorRatio: number, wheelDelta: number) => {
      const factor = Math.exp(Math.max(-600, Math.min(600, wheelDelta)) * 0.0015);
      setViewport((value) => zoomViewportAt(value, length, anchorRatio, factor, minimumVisible));
    },
    [length, minimumVisible, setViewport]
  );

  const panBy = React.useCallback(
    (bars: number) => setViewport((value) => panViewport(value, length, bars, minimumVisible)),
    [length, minimumVisible, setViewport]
  );

  const reset = React.useCallback(
    () => setViewport(tailViewport(length, initialVisible, minimumVisible)),
    [initialVisible, length, minimumVisible, setViewport]
  );

  return { viewport: current, setViewport, zoomAt, panBy, reset };
}
