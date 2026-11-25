/**
 * Compares experiment arms against each other and against buy-and-hold SPY and
 * QQQ from each arm's start. Pure: snapshots, benchmark closes and fills in;
 * numbers out. It never names a winner; below MIN_DAYS it says so.
 */
import { previousTradingDate } from "./calendar.js";
import { pnlBySymbol, tradedNotional } from "./trades.js";

export const MIN_DAYS_TO_CALL = 60;
export const BENCHMARKS = Object.freeze(["SPY", "QQQ"]);
const TRADING_DAYS_PER_YEAR = 252;

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);

/** Daily simple returns of an equity path that starts at `start`. */
export function dailyReturns(start, equities) {
  const path = [start, ...equities];
  return path.slice(1).map((value, index) => value / path[index] - 1);
}

export function maxDrawdown(start, equities) {
  let peak = start;
  let worst = 0;
  for (const value of [start, ...equities]) {
    peak = Math.max(peak, value);
    worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

export function sharpe(returns) {
  if (returns.length < 5) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(TRADING_DAYS_PER_YEAR) : null;
}

/**
 * Buy-and-hold return of a benchmark from the close before `startDate` to the
 * close on `endDate` (falls back to the first close on/after the base date).
 */
export function benchmarkReturn(closes, startDate, endDate) {
  const base = previousTradingDate(startDate);
  const from = closes.find((row) => row.date >= base);
  const to = [...closes].reverse().find((row) => row.date <= endDate);
  if (!from || !to || to.date < from.date) return null;
  return to.close / from.close - 1;
}

/** Benchmark daily-close path aligned to the arm's snapshot dates, rebased to the arm's start. */
function benchmarkPath(closes, startDate, dates) {
  const byDate = new Map(closes.map((row) => [row.date, row.close]));
  const base = closes.find((row) => row.date >= previousTradingDate(startDate));
  if (!base) return null;
  let last = base.close;
  return dates.map((date) => {
    if (byDate.has(date)) last = byDate.get(date);
    return last / base.close;
  });
}

/**
 * @param {object} input
 * @param {object} input.arm          swarm_arms row (+ startingCash in cents)
 * @param {Array}  input.snapshots    that arm's snapshots, oldest first
 * @param {object} input.benchmarks   { SPY: [{date, close}], QQQ: [...] }
 * @param {Array}  input.fills        that arm's fills
 * @param {Array}  input.closedTrades that arm's closed round trips
 * @param {string[]} input.pinned     symbols that count as "index" P&L (SPY, QQQ)
 */
export function armMetrics({ arm, snapshots, benchmarks, fills = [], closedTrades = [], pinned = BENCHMARKS }) {
  const start = Number(arm.startingCash);
  const series = snapshots.filter((row) => row.date >= arm.startDate);
  const equities = series.map((row) => row.equity);
  const dates = series.map((row) => row.date);
  const last = series.at(-1);
  const returnPct = last ? (last.equity / start - 1) * 100 : null;
  const bench = {};
  for (const symbol of BENCHMARKS) {
    const value = last ? benchmarkReturn(benchmarks[symbol] ?? [], arm.startDate, last.date) : null;
    bench[symbol] = value === null ? null : value * 100;
  }
  const pnl = pnlBySymbol(fills, last?.positionsJson ?? []);
  let indexPnl = 0;
  let otherPnl = 0;
  for (const [symbol, value] of pnl) {
    if (pinned.includes(symbol)) indexPnl += value; else otherPnl += value;
  }
  const averageEquity = equities.length ? equities.reduce((sum, value) => sum + value, 0) / equities.length : start;
  return {
    armId: arm.id,
    label: arm.label,
    kind: arm.kind,
    status: arm.status,
    startDate: arm.startDate,
    tradingDays: series.length,
    lastDate: last?.date ?? null,
    equityCents: last?.equity ?? start,
    returnPct: round(returnPct),
    vsSpyPct: returnPct === null || bench.SPY === null ? null : round(returnPct - bench.SPY),
    vsQqqPct: returnPct === null || bench.QQQ === null ? null : round(returnPct - bench.QQQ),
    spyReturnPct: round(bench.SPY),
    qqqReturnPct: round(bench.QQQ),
    maxDrawdownPct: round(maxDrawdown(start, equities) * 100),
    sharpe: round(sharpe(dailyReturns(start, equities))),
    turnover: round(tradedNotional(fills) / averageEquity),
    closedTrades: closedTrades.length,
    symbolsTraded: new Set(fills.map((fill) => fill.symbol)).size,
    pnlIndexCents: Math.round(indexPnl),
    pnlDiscoveredCents: Math.round(otherPnl),
    curve: dates.map((date, index) => ({ date, value: equities[index] / start })),
    benchmarkCurves: Object.fromEntries(BENCHMARKS.map((symbol) => [symbol, benchmarkPath(benchmarks[symbol] ?? [], arm.startDate, dates)])),
    tooEarlyToCall: series.length < MIN_DAYS_TO_CALL
  };
}
