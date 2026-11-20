/**
 * External data used by discovery. Every function is read-only and returns
 * plain data; failures throw with a message naming the source. `fetchImpl`
 * and `sleep` are injectable so tests never touch the network.
 */
import { readFirstSheet } from "./xlsx.js";

export const SP500_HOLDINGS_URL = "https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx";
export const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
export const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";

const SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;

/** Spaces calls so a free tier's per-minute limit is never exceeded. */
export function createRateLimiter(perMinute, { now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const interval = 60_000 / perMinute;
  let next = 0;
  return async () => {
    const at = now();
    const wait = Math.max(0, next - at);
    next = Math.max(at, next) + interval;
    if (wait > 0) await sleep(wait);
  };
}

/** Parses SSGA's SPY holdings sheet: the "Ticker" column of the holdings table. */
export function parseSp500Holdings(buffer) {
  const rows = readFirstSheet(buffer);
  const header = rows.findIndex((row) => row.some((cell) => String(cell).trim().toLowerCase() === "ticker"));
  if (header < 0) throw new Error("S&P 500 holdings file has no Ticker column.");
  const column = rows[header].findIndex((cell) => String(cell).trim().toLowerCase() === "ticker");
  const asOf = rows.slice(0, header).flat().map(String).find((cell) => /as of/i.test(cell)) ?? null;
  const symbols = [];
  for (const row of rows.slice(header + 1)) {
    const raw = String(row[column] ?? "").trim().toUpperCase().replace(/\s+/g, "");
    if (!raw) { if (symbols.length) break; continue; }
    const symbol = raw.replace(/\.(?=[A-Z]$)/, ".");
    if (SYMBOL.test(symbol) && !["USD", "CASH"].includes(symbol)) symbols.push(symbol);
  }
  const unique = [...new Set(symbols)];
  if (unique.length < 450 || unique.length > 520) throw new Error(`S&P 500 holdings parsed to ${unique.length} tickers; refusing a partial list.`);
  return { symbols: unique.sort(), asOf };
}

/** Parses Nasdaq Trader's pipe-delimited symbol directories into one map. */
export function parseNasdaqDirectory(nasdaqListed, otherListed) {
  const directory = new Map();
  const rows = (text) => String(text).split(/\r?\n/).filter((line) => line && !line.startsWith("File Creation Time")).map((line) => line.split("|"));
  const [nHead, ...nRows] = rows(nasdaqListed);
  const n = Object.fromEntries(nHead.map((name, index) => [name, index]));
  for (const row of nRows) {
    directory.set(row[n.Symbol], {
      name: row[n["Security Name"]], exchange: "NASDAQ", etf: row[n.ETF] === "Y", testIssue: row[n["Test Issue"]] === "Y",
      financialStatus: row[n["Financial Status"]] || "N"
    });
  }
  const [oHead, ...oRows] = rows(otherListed);
  const o = Object.fromEntries(oHead.map((name, index) => [name, index]));
  const exchanges = { A: "NYSE American", N: "NYSE", P: "NYSE Arca", Z: "Cboe BZX", V: "IEX" };
  for (const row of oRows) {
    // Nasdaq's directory writes class shares as BRK.B in "ACT Symbol"; Alpaca does the same.
    directory.set(row[o["ACT Symbol"]], {
      name: row[o["Security Name"]], exchange: exchanges[row[o.Exchange]] ?? row[o.Exchange], etf: row[o.ETF] === "Y",
      testIssue: row[o["Test Issue"]] === "Y", financialStatus: "N"
    });
  }
  if (directory.size < 5_000) throw new Error(`Nasdaq Trader directory has only ${directory.size} symbols; refusing a partial list.`);
  return directory;
}

export function createDiscoverySources(config, {
  fetchImpl = fetch,
  polygonLimiter = createRateLimiter(5),
  finnhubLimiter = createRateLimiter(55),
  now = () => Date.now()
} = {}) {
  const alpacaHeaders = { "APCA-API-KEY-ID": config.alpaca.key, "APCA-API-SECRET-KEY": config.alpaca.secret };
  const polygonBase = config.polygon.baseUrl || "https://api.polygon.io";

  async function request(url, label, { headers = {}, timeoutMs = 30_000, as = "json" } = {}) {
    let response;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(`${label} unreachable (${error?.cause?.code ?? error?.name ?? "network error"}).`);
    }
    if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}).`);
    if (as === "buffer") return Buffer.from(await response.arrayBuffer());
    if (as === "text") return response.text();
    return response.json();
  }

  return Object.freeze({
    configured: {
      alpaca: Boolean(config.alpaca.key && config.alpaca.secret),
      polygon: Boolean(config.polygon.key),
      finnhub: Boolean(config.finnhub.key)
    },

    async stockAssets() {
      const url = new URL("/v2/assets", config.alpaca.paperBaseUrl);
      url.searchParams.set("status", "active");
      url.searchParams.set("asset_class", "us_equity");
      const assets = await request(url, "Alpaca asset list", { headers: alpacaHeaders, timeoutMs: 60_000 });
      if (!Array.isArray(assets)) throw new Error("Alpaca asset list was not a list.");
      return assets.map((asset) => ({
        symbol: String(asset.symbol ?? "").toUpperCase(), name: String(asset.name ?? ""), exchange: String(asset.exchange ?? ""),
        tradable: Boolean(asset.tradable), fractionable: Boolean(asset.fractionable), status: asset.status
      }));
    },

    async nasdaqDirectory() {
      const [listed, other] = await Promise.all([
        request(NASDAQ_LISTED_URL, "Nasdaq Trader nasdaqlisted", { as: "text" }),
        request(OTHER_LISTED_URL, "Nasdaq Trader otherlisted", { as: "text" })
      ]);
      return parseNasdaqDirectory(listed, other);
    },

    async sp500() {
      return parseSp500Holdings(await request(SP500_HOLDINGS_URL, "S&P 500 holdings (SSGA SPY)", { as: "buffer" }));
    },

    /** Whole-market OHLCV for one date (consolidated volume). Empty on a non-trading day. */
    async groupedDaily(date) {
      await polygonLimiter();
      const url = new URL(`/v2/aggs/grouped/locale/us/market/stocks/${date}`, polygonBase);
      url.searchParams.set("adjusted", "true");
      url.searchParams.set("apiKey", config.polygon.key);
      const payload = await request(url, `Polygon grouped daily ${date}`, { timeoutMs: 60_000 });
      return (payload.results ?? []).map((row) => ({ symbol: String(row.T).toUpperCase(), open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v, vwap: row.vw ?? null }));
    },

    /** Daily split-adjusted bars for many symbols, consolidated (SIP) volume, ending 20 minutes ago. */
    async dailyBars(symbols, { days = 400, feed = config.discovery?.historicalFeed || "sip" } = {}) {
      const result = {};
      const start = new Date(now() - days * 86_400_000).toISOString().slice(0, 10);
      const end = new Date(now() - 20 * 60_000).toISOString();
      for (let index = 0; index < symbols.length; index += 50) {
        const chunk = symbols.slice(index, index + 50);
        let token = null;
        do {
          const url = new URL("/v2/stocks/bars", config.alpaca.dataBaseUrl);
          url.searchParams.set("symbols", chunk.join(","));
          url.searchParams.set("timeframe", "1Day");
          url.searchParams.set("start", start);
          url.searchParams.set("end", end);
          url.searchParams.set("adjustment", "split");
          url.searchParams.set("feed", feed);
          url.searchParams.set("limit", "10000");
          if (token) url.searchParams.set("page_token", token);
          const payload = await request(url, "Alpaca daily bars", { headers: alpacaHeaders, timeoutMs: 60_000 });
          for (const [symbol, bars] of Object.entries(payload.bars ?? {})) {
            (result[symbol] ??= []).push(...bars.map((bar) => ({ time: Date.parse(bar.t), open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v })));
          }
          token = payload.next_page_token ?? null;
        } while (token);
      }
      for (const bars of Object.values(result)) bars.sort((left, right) => left.time - right.time);
      return result;
    },

    /** Company profile and key metrics from Finnhub (two calls). */
    async fundamentals(symbol) {
      const call = async (path) => {
        await finnhubLimiter();
        const url = new URL(`https://finnhub.io/api/v1/${path}`);
        url.searchParams.set("symbol", symbol);
        if (path === "stock/metric") url.searchParams.set("metric", "all");
        url.searchParams.set("token", config.finnhub.key);
        return request(url, `Finnhub ${path}`);
      };
      const profile = await call("stock/profile2");
      const metric = (await call("stock/metric"))?.metric ?? {};
      const pick = (key) => (Number.isFinite(Number(metric[key])) && metric[key] !== null ? Number(metric[key]) : null);
      const reportedCap = Number.isFinite(Number(profile.marketCapitalization)) && profile.marketCapitalization !== null ? Number(profile.marketCapitalization) : pick("marketCapitalization");
      const shares = Number(profile.shareOutstanding);
      return {
        name: profile.name ?? null,
        industry: profile.finnhubIndustry ?? null,
        country: profile.country ?? null,
        ipo: profile.ipo ?? null,
        // Finnhub's market cap is often in the filer's home currency (Genmab in DKK, ICICI in INR),
        // and its `currency` field does not reliably say so. The service checks the figure against
        // the US trading price before using it; see verifyMarketCap in service.js.
        marketCapReportedMillions: reportedCap,
        reportedCurrency: typeof profile.currency === "string" && profile.currency ? profile.currency.toUpperCase() : null,
        sharesOutstandingMillions: Number.isFinite(shares) && shares > 0 ? shares : null,
        revenueGrowthTTM: pick("revenueGrowthTTMYoy"),
        revenueGrowth3Y: pick("revenueGrowth3Y"),
        epsGrowthTTM: pick("epsGrowthTTMYoy"),
        grossMarginTTM: pick("grossMarginTTM"),
        netMarginTTM: pick("netProfitMarginTTM"),
        roeTTM: pick("roeTTM"),
        debtToEquity: pick("totalDebt/totalEquityQuarterly"),
        psTTM: pick("psTTM"),
        peTTM: pick("peTTM"),
        beta: pick("beta")
      };
    }
  });
}
