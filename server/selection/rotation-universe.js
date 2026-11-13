/**
 * Fixed rotation universe: ~120 liquid US large caps and sector ETFs, by sector.
 *
 * Survivorship: this list was written today. Every name on it survived to today,
 * so a historical backtest over it is optimistic by construction. The service
 * attaches ROTATION_SURVIVORSHIP_WARNING to every result so no screen or backtest
 * can be read without it.
 */
export const ROTATION_BENCHMARK = "SPY";

export const ROTATION_SURVIVORSHIP_WARNING =
  "The rotation universe is a fixed list of today's large caps. Delisted and demoted names are missing, so historical results overstate what the rules would have earned.";

const SECTORS = Object.freeze({
  Technology: ["AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "CSCO", "ACN", "INTU", "QCOM", "TXN", "AMAT", "NOW", "PANW", "MU", "LRCX", "KLAC", "ANET"],
  Communication: ["GOOGL", "META", "NFLX", "DIS", "CMCSA", "TMUS", "VZ", "T"],
  "Consumer Discretionary": ["AMZN", "TSLA", "HD", "MCD", "NKE", "LOW", "SBUX", "BKNG", "TJX", "CMG", "ORLY"],
  "Consumer Staples": ["PG", "KO", "PEP", "COST", "WMT", "PM", "MDLZ", "CL", "MO"],
  "Health Care": ["LLY", "UNH", "JNJ", "ABBV", "MRK", "TMO", "ABT", "PFE", "DHR", "AMGN", "ISRG", "VRTX", "GILD", "REGN", "BSX"],
  Financials: ["JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "AXP", "BLK", "SCHW", "C", "SPGI", "PGR", "CB"],
  Industrials: ["CAT", "GE", "HON", "UNP", "RTX", "BA", "DE", "LMT", "UPS", "ETN", "ADP", "WM"],
  Energy: ["XOM", "CVX", "COP", "SLB", "EOG", "MPC", "PSX", "OXY"],
  Materials: ["LIN", "APD", "SHW", "FCX", "NEM", "NUE"],
  Utilities: ["NEE", "SO", "DUK", "CEG"],
  "Real Estate": ["PLD", "AMT", "EQIX", "O"],
  ETF: ["QQQ", "IWM", "GLD", "XLE", "XLK", "XLV", "XLF", "SMH", "XLU", "TLT"]
});

export const ROTATION_UNIVERSE = Object.freeze(
  Object.fromEntries(Object.entries(SECTORS).flatMap(([sector, symbols]) => symbols.map((symbol) => [symbol, sector])))
);

export function rotationSymbols({ includeBenchmark = true } = {}) {
  const symbols = Object.keys(ROTATION_UNIVERSE);
  return includeBenchmark && !symbols.includes(ROTATION_BENCHMARK) ? [...symbols, ROTATION_BENCHMARK] : symbols;
}

export function rotationSector(symbol) {
  const normalized = String(symbol).trim().toUpperCase();
  if (normalized === ROTATION_BENCHMARK) return "Benchmark";
  return ROTATION_UNIVERSE[normalized] ?? "Unknown";
}
