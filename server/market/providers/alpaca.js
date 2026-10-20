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

/**
 * The last trade on a thin venue (IEX, Alpaca crypto) can be many seconds old
 * while the bid/ask is current, and the paper broker rejects quotes older than
 * a few seconds. Use whichever of the last trade and the quote midpoint is
 * newer, so a quiet tape does not block every fill.
 */
export function freshestPrice(snapshot) {
  const candidates = [];
  const trade = snapshot?.latestTrade;
  if (Number(trade?.p) > 0 && trade?.t) candidates.push({ price: Number(trade.p), time: trade.t, at: Date.parse(trade.t) });
  const quote = snapshot?.latestQuote;
  const bid = Number(quote?.bp);
  const ask = Number(quote?.ap);
  // A crossed or one-sided book is not a usable price.
  if (bid > 0 && ask >= bid && quote?.t && (ask - bid) / bid <= 0.01) {
    candidates.push({ price: (bid + ask) / 2, time: quote.t, at: Date.parse(quote.t) });
  }
  const valid = candidates.filter((candidate) => Number.isFinite(candidate.at));
  if (valid.length === 0) return null;
  return valid.sort((left, right) => right.at - left.at)[0];
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
    async mostActives({ limit = 100 } = {}) {
      const url = new URL("/v1beta1/screener/stocks/most-actives", config.alpaca.dataBaseUrl);
      url.searchParams.set("by", "volume");
      url.searchParams.set("top", String(Math.max(1, Math.min(100, Number(limit) || 100))));
      const payload = await json(await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(12_000) }), "Alpaca most-actives screener");
      const entries = Array.isArray(payload) ? payload : payload.most_actives ?? payload.mostActives ?? payload.data ?? [];
      if (!Array.isArray(entries)) throw new Error("Alpaca most-actives response was not a list.");
      return entries
        .map((entry) => String(entry?.symbol ?? entry?.ticker ?? "").trim().toUpperCase())
        .filter(Boolean);
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
      const latest = freshestPrice(snapshot);
      return normalizeQuote(symbol, {
        price: latest?.price ?? snapshot.minuteBar?.c ?? snapshot.dailyBar?.c,
        previousClose: snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.o,
        volume: snapshot.dailyBar?.v ?? snapshot.minuteBar?.v ?? null,
        quoteTime: latest?.time ?? snapshot.minuteBar?.t ?? snapshot.dailyBar?.t
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
      // The response limit is a page cap. Ascending order would return the
      // oldest page in the lookback and silently omit the current trading bars.
      url.searchParams.set("sort", "desc");
      const payload = await json(await fetch(url, { headers: headers(config), signal: AbortSignal.timeout(12_000) }), "Alpaca bars");
      const values = crypto ? payload.bars?.[cryptoPair(symbol)] ?? [] : payload.bars ?? [];
      return values.map((bar) => normalizeBar(bar, "alpaca"))
        .sort((left, right) => left.time - right.time).slice(-range.limit);
    }
  };
}
