/**
 * Price-quality indicators for discovery screening.
 *
 * ADX and the three quality heuristics (volatility consistency, largest daily
 * spike, volume concentration) are ported from Gunbot Quant
 * (https://github.com/GuntharDeNiro/gunbot-quant, gunbot_quant/core/indicators.py
 * and gunbot_quant/core/screener.py), used under the MIT License:
 *
 *   Copyright (c) 2025 The Gunbot Team
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * All functions take daily bars oldest first ({high, low, close, volume}) and
 * return null when there is not enough data, never NaN.
 */
const QUALITY_WINDOW = 90;

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const round = (value, digits = 4) => (finite(value) ? Number(value.toFixed(digits)) : null);

function trueRanges(bars) {
  const ranges = [null];
  for (let index = 1; index < bars.length; index += 1) {
    const high = Number(bars[index].high);
    const low = Number(bars[index].low);
    const previousClose = Number(bars[index - 1].close);
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return ranges;
}

/** Wilder ATR seeded with the mean of the first `period` true ranges (Gunbot Quant `_atr_numba`). */
export function atrSeries(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const ranges = trueRanges(bars);
  let atr = ranges.slice(1, period + 1).reduce((sum, value) => sum + value, 0) / period;
  out[period] = atr;
  for (let index = period + 1; index < bars.length; index += 1) {
    atr = (atr * (period - 1) + ranges[index]) / period;
    out[index] = atr;
  }
  return out;
}

/** pandas `ewm(alpha, adjust=False, min_periods)` over a series with leading nulls. */
function ewm(values, alpha, minPeriods) {
  const out = new Array(values.length).fill(null);
  let state = null;
  let seen = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!finite(value)) continue;
    state = state === null ? value : (1 - alpha) * state + alpha * value;
    seen += 1;
    if (seen >= minPeriods) out[index] = state;
  }
  return out;
}

/** ADX with +DI/-DI, Wilder smoothing as an EWM with alpha 1/period (Gunbot Quant `calculate_adx_components`). */
export function adxComponents(bars, period = 14) {
  const plusDm = [null];
  const minusDm = [null];
  for (let index = 1; index < bars.length; index += 1) {
    const up = Number(bars[index].high) - Number(bars[index - 1].high);
    const down = Number(bars[index - 1].low) - Number(bars[index].low);
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const alpha = 1 / period;
  const atr = ewm(trueRanges(bars), alpha, period);
  const plusSmoothed = ewm(plusDm, alpha, period);
  const minusSmoothed = ewm(minusDm, alpha, period);
  const plusDi = [];
  const minusDi = [];
  const dx = [];
  for (let index = 0; index < bars.length; index += 1) {
    if (![atr[index], plusSmoothed[index], minusSmoothed[index]].every(finite)) {
      plusDi.push(null); minusDi.push(null); dx.push(null);
      continue;
    }
    const safeAtr = atr[index] === 0 ? 1 : atr[index];
    const plus = (100 * plusSmoothed[index]) / safeAtr;
    const minus = (100 * minusSmoothed[index]) / safeAtr;
    const sum = plus + minus;
    plusDi.push(plus);
    minusDi.push(minus);
    dx.push((100 * Math.abs(plus - minus)) / (sum === 0 ? 1 : sum));
  }
  return { adx: ewm(dx, alpha, period), plusDi, minusDi };
}

function sampleStd(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

/**
 * Quality metrics over the last 90 sessions:
 * - atrPct14: latest ATR(14) as % of price
 * - volatilityConsistency: standard deviation of daily ATR% (erratic volatility scores high)
 * - maxDailySpikePct: largest (high - low) / low in %, one wild day scores high
 * - volumeConcentrationPct: share of 90-day volume traded on the 3 busiest days
 *   (pump-and-dump and one-off news names score high; an even tape is about 3.3%)
 * - adx14: trend strength (above ~25 is a trending stock, below ~20 drifts)
 */
export function qualityMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return { atrPct14: null, volatilityConsistency: null, maxDailySpikePct: null, volumeConcentrationPct: null, adx14: null, priceVsSma200Pct: null };
  }
  const atr = atrSeries(bars, 14);
  const atrPct = atr.map((value, index) => (finite(value) && Number(bars[index].close) > 0 ? (value / Number(bars[index].close)) * 100 : null));
  const recent = bars.slice(-QUALITY_WINDOW);
  const recentAtrPct = atrPct.slice(-QUALITY_WINDOW).filter(finite);
  const spikes = recent.map((bar) => (Number(bar.low) > 0 ? ((Number(bar.high) - Number(bar.low)) / Number(bar.low)) * 100 : null)).filter(finite);
  const volumes = recent.map((bar) => Number(bar.volume ?? 0)).filter(finite);
  const totalVolume = volumes.reduce((sum, value) => sum + value, 0);
  const top3 = [...volumes].sort((a, b) => b - a).slice(0, 3).reduce((sum, value) => sum + value, 0);
  const { adx } = adxComponents(bars, 14);
  const closes = bars.map((bar) => Number(bar.close));
  const sma200 = closes.length >= 200 ? closes.slice(-200).reduce((sum, value) => sum + value, 0) / 200 : null;
  const price = closes.at(-1);
  return {
    atrPct14: round(atrPct.at(-1), 3),
    volatilityConsistency: recentAtrPct.length >= 20 ? round(sampleStd(recentAtrPct), 3) : null,
    maxDailySpikePct: spikes.length ? round(Math.max(...spikes), 2) : null,
    volumeConcentrationPct: volumes.length ? round(totalVolume > 0 ? (top3 / totalVolume) * 100 : 100, 2) : null,
    adx14: round(adx.at(-1), 2),
    priceVsSma200Pct: finite(sma200) && sma200 > 0 ? round(((price - sma200) / sma200) * 100, 2) : null
  };
}
