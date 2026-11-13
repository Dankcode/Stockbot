/**
 * Momentum rotation: rank a universe and decide what to own.
 *
 * Unlike the Board B selector (`server/experiments/selection.js`), which ranks
 * tradeability and refuses to predict returns, this module is an explicit
 * *strategy*: it ranks symbols on trailing momentum and trend, owns the leaders,
 * and moves to cash when the benchmark is below its long average. It is a
 * hypothesis to be tested against SPY and Cash, not a forecast.
 *
 * Everything here is pure. Bars are injected, nothing is fetched, and every
 * function sees history only through the bar it is evaluating, so the screener
 * and the walk-forward backtest share one implementation.
 *
 * House rules kept from the selector:
 * - Gates run before scoring; a failed gate excludes, it does not score down.
 * - Missing data is missing. A factor that cannot be measured is null, and a
 *   symbol without the full lookback is excluded with a stated blocker.
 */
import { ROTATION_BENCHMARK, rotationSector } from "./rotation-universe.js";

export const TRADING_DAYS = 252;

export const DEFAULT_ROTATION_CONFIG = Object.freeze({
  topN: 10,
  minPrice: 5,
  minDollarVolume: 20_000_000,
  maxRsi: 80,
  requireTrend: true,
  regimeSma: 200,
  maxWeight: 0.15,
  maxPerSector: 3,
  weighting: "inverse_vol",
  benchmark: ROTATION_BENCHMARK,
  weights: Object.freeze({ mom12_1: 0.35, mom6m: 0.25, mom3m: 0.15, fromHigh: 0.10, vol20: -0.15 })
});

/** Bars needed before every factor (12-1 momentum, 200-day mean, 52-week high) is measurable. */
export const ROTATION_MIN_BARS = TRADING_DAYS + 1;

export function normalizeRotationConfig(input = {}) {
  const config = { ...DEFAULT_ROTATION_CONFIG, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
  config.topN = Math.max(1, Math.min(40, Math.trunc(Number(config.topN) || DEFAULT_ROTATION_CONFIG.topN)));
  config.maxWeight = Math.max(0.01, Math.min(1, Number(config.maxWeight) || DEFAULT_ROTATION_CONFIG.maxWeight));
  config.maxPerSector = Math.max(1, Math.trunc(Number(config.maxPerSector) || DEFAULT_ROTATION_CONFIG.maxPerSector));
  if (!["inverse_vol", "equal"].includes(config.weighting)) throw new TypeError("weighting must be inverse_vol or equal.");
  config.requireTrend = config.requireTrend !== false && config.requireTrend !== "false";
  config.weights = Object.freeze({ ...DEFAULT_ROTATION_CONFIG.weights, ...(input.weights ?? {}) });
  return Object.freeze(config);
}

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 6) => (finite(value) ? Number(Number(value).toFixed(digits)) : null);

function totalReturn(closes, end, lookback, skip = 0) {
  const last = end - skip;
  const first = last - lookback;
  if (first < 0 || !(closes[first] > 0) || !finite(closes[last])) return null;
  return closes[last] / closes[first] - 1;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sma(closes, end, window) {
  return end + 1 >= window ? mean(closes.slice(end + 1 - window, end + 1)) : null;
}

function annualizedVolatility(closes, end, window = 20) {
  if (end < window) return null;
  const returns = [];
  for (let index = end - window + 1; index <= end; index += 1) returns.push(Math.log(closes[index] / closes[index - 1]));
  const average = mean(returns);
  const variance = returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

/** Wilder RSI, seeded over the first `period` changes and smoothed to `end`. */
function wilderRsi(closes, end, period = 14) {
  if (end < period) return null;
  const start = Math.max(1, end - period * 5);
  let gain = 0;
  let loss = 0;
  for (let index = start; index < start + period && index <= end; index += 1) {
    const change = closes[index] - closes[index - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  gain /= period;
  loss /= period;
  for (let index = start + period; index <= end; index += 1) {
    const change = closes[index] - closes[index - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * Factors for one symbol at bar `end` (inclusive). `bars` are daily
 * `{ time, open, high, low, close, volume }` objects in time order.
 */
export function rotationFactors(bars, end = bars.length - 1) {
  const closes = bars.map((bar) => Number(bar.close));
  const price = closes[end];
  const sma50 = sma(closes, end, 50);
  const sma200 = sma(closes, end, 200);
  const window = closes.slice(Math.max(0, end + 1 - TRADING_DAYS), end + 1);
  const high52 = window.length ? Math.max(...window) : null;
  const dollarVolumes = bars.slice(Math.max(0, end - 19), end + 1).map((bar) => Number(bar.close) * Number(bar.volume ?? 0));
  return {
    price: round(price, 4),
    bars: end + 1,
    mom12_1: round(totalReturn(closes, end, TRADING_DAYS - 21, 21)),
    mom6m: round(totalReturn(closes, end, 126)),
    mom3m: round(totalReturn(closes, end, 63)),
    mom1m: round(totalReturn(closes, end, 21)),
    vol20: round(annualizedVolatility(closes, end, 20)),
    sma50: round(sma50, 4),
    sma200: round(sma200, 4),
    trend: finite(sma50) && finite(sma200) ? price > sma50 && sma50 > sma200 : null,
    fromHigh: finite(high52) && high52 > 0 ? round(price / high52 - 1) : null,
    rsi14: round(wilderRsi(closes, end, 14), 2),
    adv20: dollarVolumes.length ? round(mean(dollarVolumes), 0) : null
  };
}

function zscores(values) {
  const measured = values.filter(finite);
  if (measured.length < 2) return values.map((value) => (finite(value) ? 0 : null));
  const average = mean(measured);
  const deviation = Math.sqrt(measured.reduce((sum, value) => sum + (value - average) ** 2, 0) / (measured.length - 1));
  return values.map((value) => (finite(value) ? (deviation > 0 ? Math.max(-3, Math.min(3, (value - average) / deviation)) : 0) : null));
}

export function marketRegime(benchmarkFactors, closes, end, window) {
  const average = sma(closes, end, window);
  const close = closes[end];
  return Object.freeze({
    benchmark: benchmarkFactors?.symbol ?? ROTATION_BENCHMARK,
    close: round(close, 4),
    sma: round(average, 4),
    window,
    riskOn: finite(average) ? close > average : null,
    distance: finite(average) && average > 0 ? round(close / average - 1) : null
  });
}

/**
 * Rank a universe at one point in time.
 *
 * @param {Record<string, Array>} barsBySymbol daily bars per symbol, each already
 *   truncated (or indexed via `endIndexBySymbol`) to the decision bar.
 */
export function rankRotation(barsBySymbol, options = {}, endIndexBySymbol = {}) {
  const config = normalizeRotationConfig(options);
  const rows = [];
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    if (!Array.isArray(bars) || bars.length === 0) continue;
    const end = endIndexBySymbol[symbol] ?? bars.length - 1;
    if (end < 0) continue;
    const factors = rotationFactors(bars, end);
    const blockers = [];
    if (symbol === config.benchmark) blockers.push("benchmark is the regime gauge, not a holding");
    if (factors.bars < ROTATION_MIN_BARS) blockers.push(`only ${factors.bars} daily bars; ${ROTATION_MIN_BARS} needed for 12-1 momentum`);
    if (finite(factors.price) && factors.price < config.minPrice) blockers.push(`price ${factors.price.toFixed(2)} below $${config.minPrice}`);
    if (!finite(factors.adv20)) blockers.push("no volume data");
    else if (factors.adv20 < config.minDollarVolume) blockers.push(`20-day dollar volume $${(factors.adv20 / 1e6).toFixed(1)}M below $${(config.minDollarVolume / 1e6).toFixed(0)}M`);
    if (config.requireTrend && factors.trend === false) blockers.push("not in an uptrend (close > 50-day > 200-day)");
    if (finite(factors.rsi14) && factors.rsi14 > config.maxRsi) blockers.push(`RSI ${factors.rsi14.toFixed(0)} above ${config.maxRsi}`);
    rows.push({ symbol, sector: rotationSector(symbol), ...factors, blockers, eligible: blockers.length === 0, time: bars[end]?.time ?? null });
  }

  // Cross-sectional z-scores over symbols with a full lookback only, so a
  // short-history name cannot distort everyone else's scale.
  const scorable = rows.filter((row) => row.bars >= ROTATION_MIN_BARS && row.symbol !== config.benchmark);
  const scores = new Map(scorable.map((row) => [row.symbol, 0]));
  const weightSum = new Map(scorable.map((row) => [row.symbol, 0]));
  for (const [factor, weight] of Object.entries(config.weights)) {
    const z = zscores(scorable.map((row) => row[factor]));
    scorable.forEach((row, index) => {
      if (z[index] === null) return;
      scores.set(row.symbol, scores.get(row.symbol) + weight * z[index]);
      weightSum.set(row.symbol, weightSum.get(row.symbol) + Math.abs(weight));
    });
  }
  for (const row of rows) {
    row.score = scores.has(row.symbol) && weightSum.get(row.symbol) > 0 ? round(scores.get(row.symbol), 4) : null;
  }
  rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  rows.forEach((row, index) => { row.rank = index + 1; });

  const selected = [];
  const perSector = new Map();
  for (const row of rows) {
    if (!row.eligible || row.score === null) continue;
    if ((perSector.get(row.sector) ?? 0) >= config.maxPerSector) {
      row.note = `sector cap: ${config.maxPerSector} ${row.sector} names already held`;
      continue;
    }
    selected.push(row.symbol);
    perSector.set(row.sector, (perSector.get(row.sector) ?? 0) + 1);
    if (selected.length >= config.topN) break;
  }
  const chosen = new Set(selected);
  rows.forEach((row) => { row.selected = chosen.has(row.symbol); });

  const benchBars = barsBySymbol[config.benchmark];
  const regime = Array.isArray(benchBars) && benchBars.length
    ? marketRegime({ symbol: config.benchmark }, benchBars.map((bar) => Number(bar.close)), endIndexBySymbol[config.benchmark] ?? benchBars.length - 1, config.regimeSma)
    : Object.freeze({ benchmark: config.benchmark, close: null, sma: null, window: config.regimeSma, riskOn: null, distance: null });

  const targets = targetWeights(rows.filter((row) => row.selected), regime, config);
  rows.forEach((row) => { row.weight = targets[row.symbol] ?? 0; });
  return Object.freeze({
    rows,
    selected,
    targets,
    cashWeight: round(1 - Object.values(targets).reduce((sum, value) => sum + value, 0)),
    regime,
    config
  });
}

/**
 * Inverse-volatility (or equal) weights, capped per position.
 * Risk-off (benchmark below its long mean) holds cash. An unmeasurable regime
 * is not treated as risk-on: without a benchmark the rule cannot be applied.
 */
export function targetWeights(selectedRows, regime, config = DEFAULT_ROTATION_CONFIG) {
  if (regime?.riskOn !== true || selectedRows.length === 0) return {};
  const vols = selectedRows.map((row) => row.vol20).filter((value) => finite(value) && value > 0).sort((a, b) => a - b);
  const medianVol = vols.length ? vols[Math.floor(vols.length / 2)] : 1;
  const raw = selectedRows.map((row) => (config.weighting === "equal" ? 1 : 1 / (finite(row.vol20) && row.vol20 > 0 ? row.vol20 : medianVol)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  let weights = raw.map((value) => value / total);
  for (let pass = 0; pass < 20; pass += 1) {
    const over = weights.map((value) => value > config.maxWeight + 1e-12);
    if (!over.some(Boolean)) break;
    const excess = weights.reduce((sum, value, index) => sum + (over[index] ? value - config.maxWeight : 0), 0);
    const underTotal = weights.reduce((sum, value, index) => sum + (over[index] ? 0 : value), 0);
    weights = weights.map((value, index) => (over[index] ? config.maxWeight : underTotal > 0 ? value + excess * value / underTotal : value));
    if (underTotal === 0) break;
  }
  return Object.fromEntries(selectedRows.map((row, index) => [row.symbol, round(weights[index])]).filter(([, value]) => value > 0));
}

/**
 * Orders that move `current` weights to `target`. Sells come first so their
 * cash is available to buys. Changes under `band` of equity are skipped unless
 * they close a position.
 */
export function rebalanceOrders(current, target, equity, prices, band = 0.02) {
  const orders = [];
  for (const symbol of [...new Set([...Object.keys(current), ...Object.keys(target)])].sort()) {
    const from = current[symbol] ?? 0;
    const to = target[symbol] ?? 0;
    const closes = to === 0 && from > 0;
    if (Math.abs(to - from) < band && !closes) continue;
    const notional = Math.abs(to - from) * equity;
    const price = prices[symbol];
    orders.push({
      symbol,
      side: to > from ? "buy" : "sell",
      notional: round(notional, 2),
      quantity: finite(price) && price > 0 ? round(notional / price, 6) : null,
      fromWeight: round(from, 4),
      toWeight: round(to, 4),
      closesPosition: closes
    });
  }
  return [...orders.filter((order) => order.side === "sell"), ...orders.filter((order) => order.side === "buy")];
}
