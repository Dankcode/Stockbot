function assertPositivePeriod(period) {
  if (!Number.isInteger(period) || period <= 0) {
    throw new TypeError(`Indicator period must be a positive integer; received ${period}.`);
  }
}

function assertValues(values) {
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Indicator input must be an array of finite numbers.");
  }
}

export function emaSeries(values, period) {
  assertValues(values);
  assertPositivePeriod(period);
  if (values.length === 0) return [];

  const multiplier = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    previous = index === 0 ? value : value * multiplier + previous * (1 - multiplier);
    return previous;
  });
}

export function smaSeries(values, period) {
  assertValues(values);
  assertPositivePeriod(period);

  const result = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index >= period) sum -= values[index - period];
    result.push(sum / Math.min(index + 1, period));
  }
  return result;
}

export function rsiSeries(values, period = 14) {
  assertValues(values);
  assertPositivePeriod(period);

  let averageGain = 0;
  let averageLoss = 0;
  return values.map((value, index) => {
    if (index === 0) return 50;

    const change = value - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      averageGain = (averageGain * (index - 1) + gain) / index;
      averageLoss = (averageLoss * (index - 1) + loss) / index;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }

    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    const relativeStrength = averageGain / averageLoss;
    return 100 - 100 / (1 + relativeStrength);
  });
}

export function trueRangeSeries(bars) {
  return bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previousClose),
      Math.abs(bar.low - previousClose)
    );
  });
}

export function atrSeries(bars, period = 14) {
  assertPositivePeriod(period);
  if (bars.length === 0) return [];

  const ranges = trueRangeSeries(bars);
  let previous = ranges[0];
  return ranges.map((value, index) => {
    previous = index === 0 ? value : (previous * (period - 1) + value) / period;
    return previous;
  });
}

export function rollingExtreme(bars, period, pick, field) {
  assertPositivePeriod(period);
  return bars.map((bar, index) => {
    const start = Math.max(0, index - period);
    let extreme;
    for (let cursor = start; cursor < index; cursor += 1) {
      const value = bars[cursor][field];
      extreme = extreme === undefined ? value : pick(extreme, value);
    }
    return extreme === undefined ? bar[field] : extreme;
  });
}

/**
 * Precomputes indicator series once. `at(index)` returns a facade whose arrays
 * end at the current closed bar so an algorithm cannot inspect future values.
 */
export function createIndicators(bars) {
  const closes = bars.map((bar) => bar.close);
  const cache = new Map();
  const memo = (key, compute) => {
    if (!cache.has(key)) cache.set(key, Object.freeze(compute()));
    return cache.get(key);
  };

  const full = {
    ema: (period) => memo(`ema:${period}`, () => emaSeries(closes, period)),
    sma: (period) => memo(`sma:${period}`, () => smaSeries(closes, period)),
    rsi: (period = 14) => memo(`rsi:${period}`, () => rsiSeries(closes, period)),
    atr: (period = 14) => memo(`atr:${period}`, () => atrSeries(bars, period)),
    highestHigh: (period) => memo(`highest:${period}`, () => rollingExtreme(bars, period, Math.max, "high")),
    lowestLow: (period) => memo(`lowest:${period}`, () => rollingExtreme(bars, period, Math.min, "low"))
  };

  return Object.freeze({
    closes: Object.freeze(closes),
    ...full,
    at(index) {
      const end = Math.max(0, Math.min(bars.length, index + 1));
      const bounded = (series) => Object.freeze(series.slice(0, end));
      return Object.freeze({
        ema: (period) => bounded(full.ema(period)),
        sma: (period) => bounded(full.sma(period)),
        rsi: (period = 14) => bounded(full.rsi(period)),
        atr: (period = 14) => bounded(full.atr(period)),
        highestHigh: (period) => bounded(full.highestHigh(period)),
        lowestLow: (period) => bounded(full.lowestLow(period))
      });
    }
  });
}
