import { isCryptoSymbol } from "../catalog.js";
import { normalizeBar, normalizeQuote } from "../normalize.js";

async function json(response, label) {
  if (!response.ok) throw new Error(`${label} failed (${response.status}).`);
  return response.json();
}

export function finnhubProvider(config) {
  return {
    id: "finnhub",
    configured: () => Boolean(config.finnhub.key),
    async quote(symbol) {
      if (isCryptoSymbol(symbol)) throw new Error("Finnhub stock quote provider does not support this crypto symbol.");
      const url = new URL("https://finnhub.io/api/v1/quote");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("token", config.finnhub.key);
      const payload = await json(await fetch(url, { signal: AbortSignal.timeout(8_000) }), "Finnhub quote");
      return normalizeQuote(symbol, { price: payload.c, previousClose: payload.pc || payload.o, quoteAt: payload.t ? payload.t * 1000 : Number.NaN }, "finnhub");
    },
    async bars(symbol, range) {
      if (isCryptoSymbol(symbol)) throw new Error("Finnhub stock bar provider does not support this crypto symbol.");
      const url = new URL("https://finnhub.io/api/v1/stock/candle");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("resolution", range.finnhubResolution);
      url.searchParams.set("from", String(Math.floor((Date.now() - range.lookbackDays * 86_400_000) / 1000)));
      url.searchParams.set("to", String(Math.floor(Date.now() / 1000)));
      url.searchParams.set("token", config.finnhub.key);
      const payload = await json(await fetch(url, { signal: AbortSignal.timeout(12_000) }), "Finnhub bars");
      if (payload.s !== "ok") throw new Error(payload.error || `Finnhub returned ${payload.s || "no data"}.`);
      return payload.t.map((time, index) => normalizeBar({ t: time, o: payload.o[index], h: payload.h[index], l: payload.l[index], c: payload.c[index], v: payload.v[index] }, "finnhub")).slice(-range.limit);
    }
  };
}
