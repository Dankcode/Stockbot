import { deflateRawSync } from "node:zlib";

/** Builds a minimal .xlsx (zip with shared strings + one sheet) for parser tests. */
export function makeXlsx(rows) {
  const shared = [];
  const index = (value) => { const at = shared.indexOf(value); if (at >= 0) return at; shared.push(value); return shared.length - 1; };
  const columns = (n) => String.fromCharCode(65 + n);
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) =>
    typeof cell === "number" ? `<c r="${columns(c)}${r + 1}"><v>${cell}</v></c>` : `<c r="${columns(c)}${r + 1}" t="s"><v>${index(cell)}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const strings = `<?xml version="1.0"?><sst>${shared.map((value) => `<si><t>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("")}</sst>`;
  const files = [["xl/sharedStrings.xml", strings], ["xl/worksheets/sheet1.xml", sheet]];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBuffer = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/** Deterministic daily bars: `drift` per day, `wiggle` amplitude, `days` long, `volume` shares. */
export function makeBars({ start = 50, drift = 0.001, wiggle = 0.01, days = 300, volume = 2_000_000, end = Date.UTC(2026, 10, 19), pumpDays = 0, spikeDay = false } = {}) {
  let price = start;
  return Array.from({ length: days }, (_, index) => {
    price *= 1 + drift + wiggle * Math.sin(index * 1.3);
    const pumped = index >= days - 10 && index < days - 10 + pumpDays; // a few days late in the window with 40x volume
    const spiked = spikeDay && index === days - 20; // one session trading 60% from low to high
    return { time: end - (days - 1 - index) * 86_400_000, open: price, high: price * (spiked ? 1.5 : 1.01), low: price * (spiked ? 0.94 : 0.99), close: Number(price.toFixed(4)), volume: pumped ? volume * 40 : volume };
  });
}

/**
 * A fake market with deliberately different listings. Exactly GROW, STDY and
 * SLOW may become candidates; every other symbol must be excluded for the stated reason.
 */
export const LISTINGS = Object.freeze([
  { symbol: "GROW", name: "Growth Rocket Inc", exchange: "NASDAQ", close: 40, volume: 2_000_000, bars: { drift: 0.004, wiggle: 0.01 }, fundamentals: { marketCapMillions: 4_000, revenueGrowthTTM: 60, revenueGrowth3Y: 45, netMarginTTM: 8, roeTTM: 12, debtToEquity: 0.2 } },
  { symbol: "STDY", name: "Steady Compounder Corp", exchange: "NYSE", close: 80, volume: 1_000_000, bars: { drift: 0.0008, wiggle: 0.003 }, fundamentals: { marketCapMillions: 12_000, revenueGrowthTTM: 9, revenueGrowth3Y: 10, netMarginTTM: 22, roeTTM: 25, debtToEquity: 0.3 } },
  { symbol: "SLOW", name: "Slow Decline Holdings", exchange: "NYSE", close: 30, volume: 3_000_000, bars: { drift: -0.002, wiggle: 0.02 }, fundamentals: { marketCapMillions: 2_000, revenueGrowthTTM: -10, revenueGrowth3Y: -4, netMarginTTM: -15, roeTTM: -8, debtToEquity: 2.5 } },
  { symbol: "TINY", name: "Tiny Cap Inc", exchange: "NASDAQ", close: 12, volume: 1_500_000, bars: { drift: 0.005, wiggle: 0.01 }, fundamentals: { marketCapMillions: 90 } },
  { symbol: "NVDA", name: "NVIDIA Corp", exchange: "NASDAQ", close: 180, volume: 200_000_000, sp500: true },
  { symbol: "QQQ", name: "Invesco QQQ Trust", exchange: "NASDAQ", close: 500, volume: 40_000_000, etf: true },
  { symbol: "ABCW", name: "ABC Corp Warrants", exchange: "NASDAQ", close: 1.2, volume: 9_000_000 },
  { symbol: "SPAQ", name: "Space Acquisition Corp", exchange: "NYSE", close: 10.1, volume: 5_000_000 },
  { symbol: "OTCY", name: "Pink Sheet Co", exchange: "OTC", close: 20, volume: 5_000_000 },
  { symbol: "ZVZZT", name: "Test Issue", exchange: "NASDAQ", close: 10, volume: 5_000_000, testIssue: true },
  { symbol: "PENNY", name: "Penny Stock Inc", exchange: "NASDAQ", close: 2.5, volume: 50_000_000 },
  { symbol: "THIN", name: "Thin Float Corp", exchange: "NYSE", close: 25, volume: 20_000 },
  { symbol: "NEWCO", name: "New Listing Inc", exchange: "NASDAQ", close: 30, volume: 2_000_000, bars: { days: 25 } }
]);

/** Listings for specific tests, added with fakeSources({ extra }). */
export const EXTRA_LISTINGS = Object.freeze({
  PUMP: { symbol: "PUMP", name: "Pumped Ventures Inc", exchange: "NASDAQ", close: 20, volume: 3_000_000, bars: { drift: 0.003, wiggle: 0.01, pumpDays: 3 } },
  SPKE: { symbol: "SPKE", name: "Spike Therapeutics Inc", exchange: "NASDAQ", close: 15, volume: 3_000_000, bars: { drift: 0.002, wiggle: 0.01, spikeDay: true } },
  FORN: { symbol: "FORN", name: "Foreign Pharma A/S", exchange: "NASDAQ", close: 60, volume: 1_000_000, bars: { drift: 0.001, wiggle: 0.005 }, fundamentals: { marketCapReportedMillions: 209_521, reportedCurrency: "USD", sharesOutstandingMillions: 62.41, revenueGrowthTTM: 20 } },
  "BRK.A": { symbol: "BRK.A", name: "Berkshire Hathaway Inc Class A", exchange: "NYSE", close: 700_000, volume: 300 }
});

export function fakeSources({ failSp500 = false, failFundamentals = new Set(), calls = {}, extra = [], extraSp500 = [] } = {}) {
  const LISTINGS_ALL = [...LISTINGS, ...extra.map((symbol) => EXTRA_LISTINGS[symbol])];
  const count = (key) => { calls[key] = (calls[key] ?? 0) + 1; };
  const directory = new Map();
  for (const listing of LISTINGS_ALL) directory.set(listing.symbol, { name: listing.name, exchange: listing.exchange, etf: Boolean(listing.etf), testIssue: Boolean(listing.testIssue), financialStatus: "N" });
  const sp500 = ["AAPL", "MSFT", ...LISTINGS_ALL.filter((listing) => listing.sp500).map((listing) => listing.symbol), ...extraSp500];
  return {
    calls,
    configured: { alpaca: true, polygon: true, finnhub: true },
    async stockAssets() { count("stockAssets"); return LISTINGS_ALL.map((listing) => ({ symbol: listing.symbol, name: listing.name, exchange: listing.exchange, tradable: true, fractionable: true })); },
    async nasdaqDirectory() { count("nasdaqDirectory"); return directory; },
    async sp500() { count("sp500"); if (failSp500) throw new Error("SSGA unreachable"); return { symbols: sp500, asOf: "As of 19-Nov-2026" }; },
    async groupedDaily(date) {
      count("groupedDaily");
      if (date === "2026-11-11") return []; // Veterans Day in this fixture: no trading
      return LISTINGS_ALL.map((listing) => ({ symbol: listing.symbol, open: listing.close, high: listing.close, low: listing.close, close: listing.close, volume: listing.volume }));
    },
    async dailyBars(symbols) {
      count("dailyBars");
      calls.barSymbols = [...(calls.barSymbols ?? []), ...symbols];
      return Object.fromEntries(symbols.map((symbol) => {
        const listing = LISTINGS_ALL.find((item) => item.symbol === symbol);
        return [symbol, makeBars({ start: listing.close, volume: listing.volume, ...(listing.bars ?? {}) })];
      }));
    },
    async fundamentals(symbol) {
      count("fundamentals");
      calls.fundamentalSymbols = [...(calls.fundamentalSymbols ?? []), symbol];
      if (failFundamentals.has(symbol)) throw new Error("Finnhub rate limited");
      const listing = LISTINGS_ALL.find((item) => item.symbol === symbol);
      const { marketCapMillions, ...rest } = listing.fundamentals ?? {};
      // Finnhub shape: a reported cap with no share count is used as USD unless another currency is named.
      return { name: listing.name, industry: "Test", ...(marketCapMillions !== undefined ? { marketCapReportedMillions: marketCapMillions, reportedCurrency: "USD" } : {}), ...rest };
    }
  };
}
