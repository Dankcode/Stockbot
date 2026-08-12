const EQUITY_PERIODS = Object.freeze({
  "1min": 252 * 390,
  "5min": 252 * 78,
  "15min": 252 * 26,
  "30min": 252 * 13,
  "1hour": 252 * 6.5,
  "1day": 252,
  "1week": 52,
  "1month": 12
});

const CRYPTO_PERIODS = Object.freeze({
  "1min": 365 * 24 * 60,
  "5min": 365 * 24 * 12,
  "15min": 365 * 24 * 4,
  "30min": 365 * 24 * 2,
  "1hour": 365 * 24,
  "1day": 365,
  "1week": 365 / 7,
  "1month": 12
});

const INTERVAL_ALIASES = Object.freeze({
  "1m": "1min",
  "1min": "1min",
  "5m": "5min",
  "5min": "5min",
  "15m": "15min",
  "15min": "15min",
  "30m": "30min",
  "30min": "30min",
  "1h": "1hour",
  "1hr": "1hour",
  "1hour": "1hour",
  "1d": "1day",
  "1day": "1day",
  "1w": "1week",
  "1week": "1week",
  "1mo": "1month",
  "1month": "1month"
});

function round(value, precision = 6) {
  return Number(value.toFixed(precision));
}

export function normalizeInterval(interval) {
  const key = String(interval ?? "").trim().toLowerCase();
  const normalized = INTERVAL_ALIASES[key];
  if (!normalized) throw new TypeError(`Unsupported bar interval: ${interval}.`);
  return normalized;
}

export function annualizationPeriods(interval, assetClass = "equity") {
  const normalized = normalizeInterval(interval);
  const calendar = assetClass === "crypto" ? CRYPTO_PERIODS : EQUITY_PERIODS;
  return calendar[normalized];
}

export function maxDrawdownPercent(equityCurve) {
  let peak = Number(equityCurve[0]?.equity ?? 0);
  let maximum = 0;
  for (const point of equityCurve) {
    const equity = Number(point.equity);
    if (!Number.isFinite(equity)) throw new TypeError("Equity curve values must be finite.");
    peak = Math.max(peak, equity);
    if (peak > 0) maximum = Math.max(maximum, ((peak - equity) / peak) * 100);
  }
  return round(maximum);
}

export function sharpeRatio(equityCurve, interval, assetClass = "equity") {
  if (equityCurve.length < 3) return 0;
  const returns = [];
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = Number(equityCurve[index - 1].equity);
    const current = Number(equityCurve[index].equity);
    if (previous > 0 && Number.isFinite(current)) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return 0;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(returns.length - 1, 1);
  const deviation = Math.sqrt(variance);
  return deviation > 0 ? round((mean / deviation) * Math.sqrt(annualizationPeriods(interval, assetClass))) : 0;
}

export function sortinoRatio(equityCurve, interval, assetClass = "equity") {
  if (equityCurve.length < 3) return null;
  const returns = [];
  for (let index = 1; index < equityCurve.length; index += 1) {
    const previous = Number(equityCurve[index - 1].equity);
    const current = Number(equityCurve[index].equity);
    if (previous > 0 && Number.isFinite(current)) returns.push(current / previous - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const downsideVariance = returns.reduce((sum, value) => sum + Math.min(0, value) ** 2, 0) / returns.length;
  const downsideDeviation = Math.sqrt(downsideVariance);
  return downsideDeviation > 0
    ? round((mean / downsideDeviation) * Math.sqrt(annualizationPeriods(interval, assetClass)))
    : null;
}

export function computeMetrics({
  equityCurve,
  trades = [],
  startingEquity,
  interval = "1day",
  assetClass = "equity",
  barsInPosition = 0,
  totalBars = Math.max(equityCurve.length - 1, 0),
  openPosition = false
}) {
  if (!Array.isArray(equityCurve) || equityCurve.length === 0) {
    throw new TypeError("equityCurve must contain at least one point.");
  }
  const start = Number(startingEquity ?? equityCurve[0].equity);
  const finalEquity = Number(equityCurve[equityCurve.length - 1].equity);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(finalEquity)) {
    throw new TypeError("Starting and final equity must be finite, with positive starting equity.");
  }

  const exits = trades.filter((trade) => trade.side === "sell");
  const wins = exits.filter((trade) => Number(trade.realizedPnl) > 0);
  const grossWin = wins.reduce((sum, trade) => sum + Number(trade.realizedPnl), 0);
  const grossLoss = exits
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .reduce((sum, trade) => sum + Math.abs(Number(trade.realizedPnl)), 0);
  const pnlPercentSum = exits.reduce((sum, trade) => sum + Number(trade.pnlPercent ?? 0), 0);

  return Object.freeze({
    returnPercent: round(((finalEquity - start) / start) * 100),
    finalEquity: round(finalEquity),
    tradeCount: trades.length,
    closedTradeCount: exits.length,
    winRate: exits.length > 0 ? round((wins.length / exits.length) * 100) : null,
    maxDrawdown: maxDrawdownPercent(equityCurve),
    sharpe: sharpeRatio(equityCurve, interval, assetClass),
    sortino: sortinoRatio(equityCurve, interval, assetClass),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    exposurePercent: totalBars > 0 ? round((barsInPosition / totalBars) * 100) : 0,
    avgTradePercent: exits.length > 0 ? round(pnlPercentSum / exits.length) : null,
    openPosition: Boolean(openPosition)
  });
}
