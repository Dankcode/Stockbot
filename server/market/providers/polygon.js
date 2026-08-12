import { isCryptoSymbol } from "../catalog.js";
import { normalizeBar, normalizeQuote } from "../normalize.js";

async function json(response, label) {
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  return response.json();
}

export function polygonProvider(config) {
  return {
    id: "polygon",
    configured: () => Boolean(config.polygon.key),
    async quote(symbol) {
      if (isCryptoSymbol(symbol)) throw new Error("Polygon stock quote provider does not support this crypto symbol.");
      const url = new URL(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`, "https://api.polygon.io");
      url.searchParams.set("adjusted", "true");
      url.searchParams.set("apiKey", config.polygon.key);
      const payload = await json(await fetch(url, { signal: AbortSignal.timeout(8_000) }), "Polygon quote");
      const bar = payload.results?.[0];
      if (!bar) throw new Error(payload.error || "Polygon returned no quote.");
      return normalizeQuote(symbol, { price: bar.c, previousClose: bar.o || bar.c, volume: bar.v, quoteAt: bar.t }, "polygon");
    },
    async bars(symbol, range) {
      if (isCryptoSymbol(symbol)) throw new Error("Polygon stock bar provider does not support this crypto symbol.");
      const from = new Date(Date.now() - range.lookbackDays * 86_400_000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      const url = new URL(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${range.polygonMultiplier}/${range.polygonTimespan}/${from}/${to}`, "https://api.polygon.io");
      url.searchParams.set("adjusted", "true");
      url.searchParams.set("sort", "asc");
      url.searchParams.set("limit", String(Math.max(range.limit, 5_000)));
      url.searchParams.set("apiKey", config.polygon.key);
      const payload = await json(await fetch(url, { signal: AbortSignal.timeout(12_000) }), "Polygon bars");
      const values = payload.results ?? [];
      return values.map((bar) => normalizeBar(bar, "polygon")).slice(-range.limit);
    }
  };
}
