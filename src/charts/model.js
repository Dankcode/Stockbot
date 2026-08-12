const MINUTE = 60_000;
const DAY = 86_400_000;

export function toTimestamp(time) {
  if (typeof time === "number") {
    return Number.isFinite(time) ? time : Number.NaN;
  }
  const timestamp = Date.parse(time);
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

export function clampViewport(viewport, length, minimumVisible = 2) {
  const itemCount = Math.max(0, Math.trunc(Number(length) || 0));
  if (itemCount === 0) {
    return { startIndex: 0, endIndex: 0 };
  }

  const minimum = Math.min(itemCount, Math.max(1, Math.trunc(minimumVisible)));
  const rawStart = Number.isFinite(viewport?.startIndex) ? Math.floor(viewport.startIndex) : 0;
  const rawEnd = Number.isFinite(viewport?.endIndex) ? Math.ceil(viewport.endIndex) : itemCount;
  const width = Math.max(minimum, Math.min(itemCount, rawEnd - rawStart || itemCount));
  const startIndex = Math.max(0, Math.min(itemCount - width, rawStart));
  return { startIndex, endIndex: startIndex + width };
}

export function tailViewport(length, visibleCount = length, minimumVisible = 2) {
  const itemCount = Math.max(0, Math.trunc(Number(length) || 0));
  const count = Math.max(1, Math.min(itemCount, Math.trunc(Number(visibleCount) || itemCount)));
  return clampViewport({ startIndex: itemCount - count, endIndex: itemCount }, itemCount, minimumVisible);
}

export function zoomViewportAt(viewport, length, anchorRatio, factor, minimumVisible = 8) {
  const current = clampViewport(viewport, length, minimumVisible);
  if (current.endIndex <= current.startIndex) {
    return current;
  }
  const ratio = Math.max(0, Math.min(1, Number(anchorRatio) || 0));
  const currentWidth = current.endIndex - current.startIndex;
  const nextWidth = Math.max(
    Math.min(length, minimumVisible),
    Math.min(length, Math.round(currentWidth * Math.max(0.05, Number(factor) || 1)))
  );
  const anchorIndex = current.startIndex + ratio * currentWidth;
  const startIndex = Math.round(anchorIndex - ratio * nextWidth);
  return clampViewport({ startIndex, endIndex: startIndex + nextWidth }, length, minimumVisible);
}

export function panViewport(viewport, length, delta, minimumVisible = 2) {
  const current = clampViewport(viewport, length, minimumVisible);
  const shift = Math.round(Number(delta) || 0);
  return clampViewport(
    { startIndex: current.startIndex + shift, endIndex: current.endIndex + shift },
    length,
    minimumVisible
  );
}

export function computeExtrema(bars) {
  if (!bars.length) {
    return null;
  }

  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  let minPositive = Number.POSITIVE_INFINITY;
  let maxVolume = 0;
  for (const bar of bars) {
    const values = [bar.open, bar.high, bar.low, bar.close];
    for (const value of values) {
      if (!Number.isFinite(value)) {
        continue;
      }
      if (value > high) high = value;
      if (value < low) low = value;
      if (value > 0 && value < minPositive) minPositive = value;
    }
    if (Number.isFinite(bar.volume) && bar.volume > maxVolume) {
      maxVolume = bar.volume;
    }
  }

  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return null;
  }
  return {
    high,
    low,
    minPositive: Number.isFinite(minPositive) ? minPositive : null,
    maxVolume
  };
}

export function aggregateBarsToPixels(bars, viewport, pixelWidth, minimumBarWidth = 2) {
  const clamped = clampViewport(viewport, bars.length, 1);
  const visibleCount = clamped.endIndex - clamped.startIndex;
  if (visibleCount <= 0) {
    return [];
  }

  const bucketCapacity = Math.max(1, Math.floor(Math.max(1, pixelWidth) / Math.max(1, minimumBarWidth)));
  const groupSize = Math.max(1, Math.ceil(visibleCount / bucketCapacity));
  const buckets = [];

  for (let sourceStart = clamped.startIndex; sourceStart < clamped.endIndex; sourceStart += groupSize) {
    const sourceEnd = Math.min(clamped.endIndex, sourceStart + groupSize);
    const first = bars[sourceStart];
    const last = bars[sourceEnd - 1];
    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let volume = 0;
    for (let index = sourceStart; index < sourceEnd; index += 1) {
      const bar = bars[index];
      if (Number.isFinite(bar.high) && bar.high > high) high = bar.high;
      if (Number.isFinite(bar.low) && bar.low < low) low = bar.low;
      if (Number.isFinite(bar.volume)) volume += Math.max(0, bar.volume);
    }
    buckets.push({
      time: last.time,
      startTime: first.time,
      endTime: last.time,
      open: first.open,
      high: Number.isFinite(high) ? high : Math.max(first.open, last.close),
      low: Number.isFinite(low) ? low : Math.min(first.open, last.close),
      close: last.close,
      volume,
      sourceStart,
      sourceEnd,
      sourceIndex: sourceEnd - 1
    });
  }

  return buckets;
}

const INTRADAY_FORMAT = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" });

export function formatTimeTick(time, interval = "", spanMs = 0) {
  const timestamp = toTimestamp(time);
  if (!Number.isFinite(timestamp)) {
    return String(time);
  }
  const date = new Date(timestamp);
  const normalizedInterval = String(interval).toLowerCase();
  const intraday = /(?:min|minute|hour|^\d+[mh]$)/.test(normalizedInterval) || spanMs <= 2 * DAY;
  if (intraday) {
    return INTRADAY_FORMAT.format(date);
  }
  if (spanMs <= 120 * DAY) {
    return DATE_FORMAT.format(date);
  }
  return MONTH_FORMAT.format(date);
}

export function selectTimeTicks(items, pixelWidth, interval = "", minimumSpacing = 76) {
  if (!items.length) {
    return [];
  }
  const maximumTicks = Math.max(2, Math.floor(Math.max(1, pixelWidth) / Math.max(40, minimumSpacing)) + 1);
  const tickCount = Math.min(items.length, maximumTicks);
  const firstTime = toTimestamp(items[0].time);
  const lastTime = toTimestamp(items[items.length - 1].time);
  const spanMs = Number.isFinite(firstTime) && Number.isFinite(lastTime) ? Math.max(MINUTE, lastTime - firstTime) : 0;
  const used = new Set();
  const ticks = [];

  for (let index = 0; index < tickCount; index += 1) {
    const itemIndex = tickCount === 1 ? 0 : Math.round((index / (tickCount - 1)) * (items.length - 1));
    if (used.has(itemIndex)) {
      continue;
    }
    used.add(itemIndex);
    ticks.push({
      itemIndex,
      time: items[itemIndex].time,
      label: formatTimeTick(items[itemIndex].time, interval, spanMs)
    });
  }
  return ticks;
}

export function nearestTimeIndex(items, time) {
  if (!items.length) {
    return -1;
  }
  const target = toTimestamp(time);
  if (!Number.isFinite(target)) {
    return items.findIndex((item) => item.time === time);
  }

  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const timestamp = toTimestamp(items[middle].time);
    if (timestamp === target) return middle;
    if (!Number.isFinite(timestamp) || timestamp < target) low = middle + 1;
    else high = middle - 1;
  }
  if (low <= 0) return 0;
  if (low >= items.length) return items.length - 1;
  const before = toTimestamp(items[low - 1].time);
  const after = toTimestamp(items[low].time);
  return Math.abs(target - before) <= Math.abs(after - target) ? low - 1 : low;
}

