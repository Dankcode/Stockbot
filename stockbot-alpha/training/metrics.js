/**
 * Performance metrics — one definition each, with explicit sign conventions
 * and honest nulls.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 * Four bugs from the code review (finding C7) live in the legacy metric block
 * at server/index.js:1076–1089, and every one of them corrupts a strategy
 * ranking rather than merely being imprecise:
 *
 *   • Sharpe annualized by sqrt(252) regardless of bar interval. A 1-hour
 *     Sharpe and a daily Sharpe were placed in the same column and compared.
 *     Here the factor is derived from the actual median bar spacing.
 *   • profitFactor returned the literal 99 when a strategy had no losing
 *     trades, which sorts it straight to the top of any ranking. One lucky
 *     trade beat every real strategy. Here it is null, rendered as "∞".
 *   • winRate returned null with no closed trades, and the frontend coerced
 *     it to 0 — so "never traded" ranked below "lost money". Null propagates.
 *   • maxDrawdown was negative and displayed raw, reading as a gain in a
 *     table where negative meant bad. Here it is a positive magnitude, always.
 *
 * Sign convention, stated once: every metric is expressed so that the
 * direction in `METRIC_META[key].higherIsBetter` is the only thing a caller
 * needs to know to rank on it.
 */

/** Metric registry — the single vocabulary the whole package formats against. */
export const METRIC_META = Object.freeze({
  returnPercent: { label: "Return", unit: "%", precision: 2, higherIsBetter: true, signed: true },
  finalEquity: { label: "Final equity", unit: "$", precision: 2, higherIsBetter: true },
  cagrPercent: { label: "CAGR", unit: "%", precision: 2, higherIsBetter: true, signed: true },
  maxDrawdown: { label: "Max drawdown", unit: "%", precision: 2, higherIsBetter: false },
  sharpe: { label: "Sharpe", unit: "", precision: 2, higherIsBetter: true, signed: true },
  sortino: { label: "Sortino", unit: "", precision: 2, higherIsBetter: true, signed: true },
  calmar: { label: "Calmar", unit: "", precision: 2, higherIsBetter: true, signed: true },
  profitFactor: { label: "Profit factor", unit: "", precision: 2, higherIsBetter: true },
  winRate: { label: "Win rate", unit: "%", precision: 1, higherIsBetter: true },
  tradeCount: { label: "Trades", unit: "", precision: 0, higherIsBetter: null },
  exposurePercent: { label: "Exposure", unit: "%", precision: 1, higherIsBetter: null },
  avgTradePercent: { label: "Avg trade", unit: "%", precision: 2, higherIsBetter: true, signed: true },
  totalCosts: { label: "Costs paid", unit: "$", precision: 2, higherIsBetter: false }
});

/** Format a metric for display. Null renders honestly, never as zero. */
export function formatMetric(key, value) {
  const meta = METRIC_META[key];
  if (!meta) return String(value);
  if (value == null) {
    return key === "profitFactor" ? "∞" : "—";
  }
  if (!Number.isFinite(value)) return "—";

  const sign = meta.signed && value > 0 ? "+" : "";
  const body = value.toFixed(meta.precision);
  if (meta.unit === "$") return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(meta.precision)}`;
  return `${sign}${body}${meta.unit}`;
}

/** Periods per year, inferred from median bar spacing. */
export function periodsPerYear(times) {
  if (!Array.isArray(times) || times.length < 3) return 252;
  const gaps = [];
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1]);
  gaps.sort((a, b) => a - b);
  const medianGapMs = gaps[Math.floor(gaps.length / 2)];
  if (!(medianGapMs > 0)) return 252;

  const dayMs = 86_400_000;
  if (medianGapMs >= dayMs * 25) return 12;       // monthly
  if (medianGapMs >= dayMs * 6) return 52;        // weekly
  if (medianGapMs >= dayMs * 0.9) return 252;     // daily
  // Intraday: 252 trading days × sessions per 6.5-hour day.
  const barsPerSession = (6.5 * 3_600_000) / medianGapMs;
  return 252 * Math.max(1, barsPerSession);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute the full metric set from an equity curve and a trade list.
 *
 * @param {object} params
 * @param {Array<{at: number, equity: number}>} params.equityCurve
 * @param {Array<{side: string, pnl?: number, pnlPercent?: number}>} params.trades
 * @param {number} params.startingCash
 * @param {number} [params.barsInPosition]
 * @param {number} [params.totalBars]
 * @param {number} [params.totalCosts]
 * @param {number} [params.riskFreeRate=0] annual, as a decimal
 * @returns {object}
 */
export function computeMetrics({
  equityCurve,
  trades = [],
  startingCash,
  barsInPosition = 0,
  totalBars = 0,
  totalCosts = 0,
  riskFreeRate = 0
}) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    throw new Error("computeMetrics: equityCurve must be a non-empty array");
  }

  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  const returnPercent = ((finalEquity - startingCash) / startingCash) * 100;

  // Period returns, plus peak-tracking for drawdown in the same pass.
  const periodReturns = [];
  let peak = equityCurve[0].equity;
  let maxDrawdown = 0;
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    if (prev > 0) periodReturns.push(curr / prev - 1);
    peak = Math.max(peak, curr);
    if (peak > 0) {
      // Positive magnitude, always. A 12% fall from peak is 12, not -12.
      maxDrawdown = Math.max(maxDrawdown, ((peak - curr) / peak) * 100);
    }
  }

  const times = equityCurve.map((p) => p.at);
  const ppy = periodsPerYear(times);
  const perPeriodRf = riskFreeRate / ppy;

  const excess = periodReturns.map((r) => r - perPeriodRf);
  const sd = stdDev(excess);
  const sharpe = sd > 0 ? (mean(excess) / sd) * Math.sqrt(ppy) : null;

  // Sortino penalizes only downside deviation, which is the honest question for
  // a long-only strategy: upside volatility is not a risk you want charged.
  const downside = excess.filter((r) => r < 0);
  const downsideDev = downside.length >= 2 ? Math.sqrt(mean(downside.map((r) => r ** 2))) : 0;
  const sortino = downsideDev > 0 ? (mean(excess) / downsideDev) * Math.sqrt(ppy) : null;

  const spanMs = times[times.length - 1] - times[0];
  const years = spanMs / (365.25 * 86_400_000);
  const cagrPercent =
    years > 0 && startingCash > 0 && finalEquity > 0
      ? ((finalEquity / startingCash) ** (1 / years) - 1) * 100
      : null;

  const calmar = maxDrawdown > 0 && cagrPercent != null ? cagrPercent / maxDrawdown : null;

  const closed = trades.filter((t) => t.side === "sell" && Number.isFinite(t.pnl));
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  return {
    returnPercent: round(returnPercent, 2),
    finalEquity: round(finalEquity, 2),
    cagrPercent: cagrPercent == null ? null : round(cagrPercent, 2),
    maxDrawdown: round(maxDrawdown, 2),
    sharpe: sharpe == null ? null : round(sharpe, 2),
    sortino: sortino == null ? null : round(sortino, 2),
    calmar: calmar == null ? null : round(calmar, 2),
    // null, not 99. A strategy with no losses has an undefined ratio, and
    // saying so is more useful than inventing a number that wins every sort.
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    // null, not 0. "Never closed a trade" is not "lost every trade".
    winRate: closed.length > 0 ? round((wins.length / closed.length) * 100, 1) : null,
    tradeCount: trades.length,
    closedTradeCount: closed.length,
    exposurePercent: totalBars > 0 ? round((barsInPosition / totalBars) * 100, 1) : 0,
    avgTradePercent:
      closed.length > 0 ? round(mean(closed.map((t) => t.pnlPercent ?? 0)), 2) : null,
    totalCosts: round(totalCosts, 2),
    periodsPerYear: Math.round(ppy)
  };
}

function round(value, places) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
