/** Mirrors server/market/catalog.js isCryptoSymbol for client-side hints. */
const CRYPTO = new Set(["BTCUSD", "ETHUSD", "SOLUSD", "DOGEUSD"]);

export function isCryptoSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  return normalized.includes("/") || CRYPTO.has(normalized);
}

const LABEL: Record<string, string> = {
  "1min": "every minute",
  "5min": "every 5 minutes",
  "15min": "every 15 minutes",
  "30min": "every 30 minutes",
  "1hour": "every hour",
  "1day": "once a day",
  "1week": "once a week",
  "1month": "once a month"
};

/**
 * How often a paper session gets a chance to act, in words. This is the most
 * common reason a session looks idle: a daily stock session decides once per
 * trading day and only fills at the next open.
 */
export function describeCadence(interval: string, symbols: string[]) {
  const every = LABEL[interval] ?? `every ${interval}`;
  const crypto = symbols.length > 0 && symbols.every(isCryptoSymbol);
  const higher = ["1day", "1week", "1month"].includes(interval);
  if (crypto) return `Decides ${every}, around the clock. New orders fill immediately at the live price.`;
  if (higher) {
    return `Decides ${every} at the 4:00 pm ET close and fills at the next market open (9:30 am ET). Expect few trades.`;
  }
  return `Decides ${every} while the US market is open and fills immediately at the live price.`;
}

const INTERVAL_MS: Record<string, number> = {
  "1min": 60_000,
  "5min": 300_000,
  "15min": 900_000,
  "30min": 1_800_000,
  "1hour": 3_600_000
};

/** When the scheduler next wakes this session, or a phrase when it is calendar-bound. */
export function nextDecision(interval: string, symbols: string[], now = Date.now()) {
  const crypto = symbols.length > 0 && symbols.every(isCryptoSymbol);
  const step = INTERVAL_MS[interval];
  if (step) {
    const at = Math.floor(now / step) * step + step;
    const clock = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(at);
    return crypto ? `Next check ${clock}` : `Next check ${clock} if the market is open`;
  }
  if (crypto) {
    return interval === "1day" ? "Next check at 00:00 UTC" : "Next check at the next UTC period boundary";
  }
  return "Next check at the 4:00 pm ET close";
}
