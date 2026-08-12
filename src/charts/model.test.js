import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateBarsToPixels,
  clampViewport,
  computeExtrema,
  nearestTimeIndex,
  panViewport,
  selectTimeTicks,
  tailViewport,
  zoomViewportAt
} from "./model.js";

function bars(count) {
  return Array.from({ length: count }, (_, index) => ({
    time: Date.UTC(2026, 0, 1, 9, 30 + index),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index
  }));
}

test("viewport helpers clamp, tail, cursor-zoom, and pan without escaping data", () => {
  assert.deepEqual(clampViewport({ startIndex: -20, endIndex: 40 }, 100), { startIndex: 0, endIndex: 60 });
  assert.deepEqual(tailViewport(100, 25), { startIndex: 75, endIndex: 100 });

  const zoomed = zoomViewportAt({ startIndex: 20, endIndex: 80 }, 100, 0.25, 0.5, 8);
  assert.equal(zoomed.endIndex - zoomed.startIndex, 30);
  const oldAnchor = 20 + 0.25 * 60;
  const newAnchor = zoomed.startIndex + 0.25 * 30;
  assert.ok(Math.abs(oldAnchor - newAnchor) <= 0.5);

  assert.deepEqual(panViewport({ startIndex: 75, endIndex: 100 }, 100, 50), {
    startIndex: 75,
    endIndex: 100
  });
  assert.deepEqual(panViewport({ startIndex: 10, endIndex: 35 }, 100, -50), {
    startIndex: 0,
    endIndex: 25
  });
});

test("pixel aggregation preserves OHLCV semantics and source ranges", () => {
  const source = bars(100);
  const aggregated = aggregateBarsToPixels(source, { startIndex: 0, endIndex: 100 }, 10, 2);

  assert.equal(aggregated.length, 5);
  assert.deepEqual(
    {
      open: aggregated[0].open,
      high: aggregated[0].high,
      low: aggregated[0].low,
      close: aggregated[0].close,
      volume: aggregated[0].volume,
      sourceStart: aggregated[0].sourceStart,
      sourceEnd: aggregated[0].sourceEnd,
      sourceIndex: aggregated[0].sourceIndex
    },
    {
      open: 100,
      high: 121,
      low: 99,
      close: 120,
      volume: 390,
      sourceStart: 0,
      sourceEnd: 20,
      sourceIndex: 19
    }
  );
});

test("single-pass extrema handles data sets larger than spread argument limits", () => {
  const source = bars(100_001);
  const extrema = computeExtrema(source);
  assert.deepEqual(extrema, {
    high: 100_102,
    low: 99,
    minPositive: 99,
    maxVolume: 100_010
  });
});

test("time ticks are spaced and nearest-time lookup uses binary search", () => {
  const source = bars(200);
  const ticks = selectTimeTicks(source, 640, "5min", 80);
  assert.ok(ticks.length >= 2);
  assert.equal(new Set(ticks.map((tick) => tick.itemIndex)).size, ticks.length);
  assert.equal(ticks[0].itemIndex, 0);
  assert.equal(ticks.at(-1).itemIndex, source.length - 1);

  const target = source[77].time + 10_000;
  assert.equal(nearestTimeIndex(source, target), 77);
});

