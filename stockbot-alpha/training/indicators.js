/**
 * Indicator series, memoized per backtest run.
 *
 * Carried over from server/index.js:791–976, which was already correct — the
 * Wilder RSI and ATR implementations there are the real thing. (The *other* RSI
 * in that file, `getDiagnostics` at :380, is a made-up formula applied to
 * synthetic candles; finding C1 in the code review. This module is the good one.)
 *
 * Every function returns an array aligned index-for-index with `bars`, with
 * `null` in positions where the indicator has insufficient history. Returning
 * null rather than 0 matters: a strategy comparing `rsi[i] < 30` against a
 * zero-filled warmup period will fire spurious entries on the first N bars.
 */

/** @typedef {{time: number|string, open: number, high: number, low: number, close: number, volume: number}} Bar */

export function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) throw new RangeError("smaSeries: period must be >= 1");
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (period < 1) throw new RangeError("emaSeries: period must be >= 1");
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values — standard practice, and it
  // avoids the long settling transient you get from seeding with values[0].
  let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

/** Wilder RSI (0–100). */
export function rsiSeries(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gainSum += delta;
    else lossSum -= delta;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    // Wilder smoothing, not a simple moving average of gains.
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function trueRangeSeries(bars) {
  const out = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].close;
    out[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose)
    );
  }
  return out;
}

/** Wilder ATR. */
export function atrSeries(bars, period = 14) {
  const tr = trueRangeSeries(bars);
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;

  let atr = 0;
  for (let i = 1; i <= period; i += 1) atr += tr[i] ?? 0;
  atr /= period;
  out[period] = atr;

  for (let i = period + 1; i < bars.length; i += 1) {
    atr = (atr * (period - 1) + (tr[i] ?? 0)) / period;
    out[i] = atr;
  }
  return out;
}

/**
 * Rolling extreme over the PREVIOUS `period` bars, excluding the current one.
 *
 * Excluding the current bar is deliberate and it is a look-ahead guard: a
 * breakout strategy asking "is close above the highest high of the last 20
 * bars" must not have the current bar's own high in that window, or the test
 * can never pass and the strategy silently never trades.
 */
function rollingExtreme(bars, period, pick, field) {
  const out = new Array(bars.length).fill(null);
  for (let i = period; i < bars.length; i += 1) {
    let best = bars[i - period][field];
    for (let j = i - period + 1; j < i; j += 1) {
      best = pick(best, bars[j][field]);
    }
    out[i] = best;
  }
  return out;
}

export function highestHigh(bars, period) {
  return rollingExtreme(bars, period, Math.max, "high");
}

export function lowestLow(bars, period) {
  return rollingExtreme(bars, period, Math.min, "low");
}

/** Rolling realized volatility of log returns, annualized-agnostic (per-bar sd). */
export function volatilitySeries(values, period = 20) {
  const out = new Array(values.length).fill(null);
  const returns = new Array(values.length).fill(null);
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] > 0) returns[i] = Math.log(values[i] / values[i - 1]);
  }
  for (let i = period; i < values.length; i += 1) {
    const window = returns.slice(i - period + 1, i + 1).filter((r) => r != null);
    if (window.length < 2) continue;
    const m = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - m) ** 2, 0) / (window.length - 1);
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/**
 * Build the memoized indicator facade handed to `signal()`.
 *
 * Each accessor caches by period, so an algorithm can call
 * `indicators.ema(21)` inside the bar loop without recomputing 5,000 times.
 *
 * @param {Bar[]} bars
 */
export function createIndicators(bars) {
  const closes = bars.map((bar) => bar.close);
  const cache = new Map();

  const memo = (name, period, compute) => {
    const key = `${name}:${period}`;
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  };

  return {
    closes,
    bars,
    ema: (period) => memo("ema", period, () => emaSeries(closes, period)),
    sma: (period) => memo("sma", period, () => smaSeries(closes, period)),
    rsi: (period = 14) => memo("rsi", period, () => rsiSeries(closes, period)),
    atr: (period = 14) => memo("atr", period, () => atrSeries(bars, period)),
    highestHigh: (period) => memo("hh", period, () => highestHigh(bars, period)),
    lowestLow: (period) => memo("ll", period, () => lowestLow(bars, period)),
    volatility: (period = 20) => memo("vol", period, () => volatilitySeries(closes, period))
  };
}
