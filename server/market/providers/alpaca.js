import { cryptoPair, isCryptoSymbol } from "../catalog.js";
import { normalizeBar, normalizeQuote } from "../normalize.js";

function headers(config) {
  if (!config.alpaca.key || !config.alpaca.secret) throw new Error("Alpaca credentials are not configured.");
  return { "APCA-API-KEY-ID": config.alpaca.key, "APCA-API-SECRET-KEY": config.alpaca.secret };
}

async function json(response, label) {
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  return response.json();
}

export function alpacaProvider(config) {
  return {
    id: "alpaca",
    configured: () => Boolean(config.alpaca.key && config.alpaca.secret),
    async assets() {
      const groups = await Promise.all(["us_equity", "crypto"].map(async (assetClass) => {
        const url = new URL("/v2/assets", config.alpaca.paperBaseUrl);
        url.searchParams.set("asset_class", assetClass);
        url.searchParams.set("status", "active");
        return json(await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(12_000) }), `Alpaca ${assetClass} assets`);
      }));
      const seen = new Set();
      return groups.flat().filter((asset) => {
        if (!asset.symbol || !asset.name || seen.has(asset.symbol)) return false;
        seen.add(asset.symbol);
        return true;
      }).map((asset) => ({
        symbol: String(asset.symbol).replace("/", "").toUpperCase(),
        name: asset.name,
        sector: asset.exchange || asset.class || "Market asset",
        aliases: [asset.exchange, asset.class].filter(Boolean),
        tradable: Boolean(asset.tradable)
      }));
    },
    async quote(symbol) {
      const crypto = isCryptoSymbol(symbol);
      const url = crypto
        ? new URL("/v1beta3/crypto/us/snapshots", config.alpaca.dataBaseUrl)
        : new URL(`/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, config.alpaca.dataBaseUrl);
      if (crypto) url.searchParams.set("symbols", cryptoPair(symbol));
      else url.searchParams.set("feed", config.alpaca.stockFeed);
      const payload = await json(await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(8_000) }), "Alpaca quote");
      const snapshot = crypto ? payload.snapshots?.[cryptoPair(symbol)] : payload;
      if (!snapshot) throw new Error("Alpaca returned no snapshot.");
      return normalizeQuote(symbol, {
        price: snapshot.latestTrade?.p ?? snapshot.minuteBar?.c ?? snapshot.dailyBar?.c,
        previousClose: snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.o,
        volume: snapshot.dailyBar?.v ?? snapshot.minuteBar?.v ?? null,
        quoteTime: snapshot.latestTrade?.t ?? snapshot.minuteBar?.t ?? snapshot.dailyBar?.t
      }, crypto ? "alpaca-crypto" : "alpaca-iex");
    },
    async bars(symbol, range) {
      const crypto = isCryptoSymbol(symbol);
      const url = crypto
        ? new URL("/v1beta3/crypto/us/bars", config.alpaca.dataBaseUrl)
        : new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, config.alpaca.dataBaseUrl);
      if (crypto) url.searchParams.set("symbols", cryptoPair(symbol));
      else { url.searchParams.set("feed", config.alpaca.stockFeed); url.searchParams.set("adjustment", "split"); }
      url.searchParams.set("timeframe", range.alpacaTimeframe);
      url.searchParams.set("start", new Date(Date.now() - range.lookbackDays * 86_400_000).toISOString());
      url.searchParams.set("end", new Date().toISOString());
      url.searchParams.set("limit", String(range.limit));
      url.searchParams.set("sort", "asc");
      const payload = await json(await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(12_000) }), "Alpaca bars");
      const values = crypto ? payload.bars?.[cryptoPair(symbol)] ?? [] : payload.bars ?? [];
      return values.map((bar) => normalizeBar(bar, "alpaca")).slice(-range.limit);
    }
  };
}
