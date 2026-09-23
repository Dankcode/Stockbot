import { getRangeConfig } from "../../packages/shared/ranges.js";
import { AppError, unavailable } from "../http/errors.js";
import { LOCAL_ASSETS, searchCatalog } from "./catalog.js";
import { TtlCache } from "./cache.js";
import { alpacaProvider } from "./providers/alpaca.js";
import { finnhubProvider } from "./providers/finnhub.js";
import { polygonProvider } from "./providers/polygon.js";
import { createIndicators } from "../engine/indicators.js";

function diagnostics(bars) {
  const indicators = createIndicators(bars);
  const last = bars.length - 1;
  const rsi = indicators.rsi(14)[last];
  const emaFast = indicators.ema(9)[last];
  const emaSlow = indicators.ema(21)[last];
  const atr = indicators.atr(14)[last];
  let cumulativeVolume = 0;
  let cumulativeValue = 0;
  for (const bar of bars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    cumulativeVolume += bar.volume;
    cumulativeValue += typical * bar.volume;
  }
  const available = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    rsi: available(rsi),
    emaFast: available(emaFast),
    emaSlow: available(emaSlow),
    atr: available(atr),
    vwap: cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : null
  };
}

export function createMarketService(config) {
  const providers = [alpacaProvider(config), polygonProvider(config), finnhubProvider(config)];
  const quoteCache = new TtlCache();
  const barsCache = new TtlCache();
  const catalogCache = new TtlCache();
  const selectionUniverseCache = new TtlCache();
  const forwardTestOnlySymbols = new Set();
  const health = new Map(providers.map((provider) => [provider.id, {
    id: provider.id,
    configured: provider.configured(),
    status: provider.configured() ? "unknown" : "unconfigured",
    lastSuccessAt: null,
    lastErrorAt: null,
    latencyMs: null,
    message: provider.configured() ? "Not checked yet" : "Credentials not configured"
  }]));

  async function attempt(method, symbol, range) {
    const errors = [];
    for (const provider of providers) {
      if (!provider.configured()) continue;
      const started = Date.now();
      try {
        const value = await provider[method](symbol, range);
        if (method === "bars" && value.length === 0) throw new Error("Provider returned no bars.");
        health.set(provider.id, {
          ...health.get(provider.id), status: "healthy", lastSuccessAt: Date.now(), latencyMs: Date.now() - started, message: "Available"
        });
        return { value, provider: provider.id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ provider: provider.id, message });
        health.set(provider.id, {
          ...health.get(provider.id), status: "degraded", lastErrorAt: Date.now(), latencyMs: Date.now() - started, message
        });
      }
    }
    throw unavailable(`Real ${method === "bars" ? "historical bars" : "quote"} unavailable for ${symbol}.`, { attempts: errors });
  }

  async function catalog() {
    const cached = catalogCache.get("assets");
    if (cached) return cached;
    const alpaca = providers.find((provider) => typeof provider.assets === "function" && provider.configured());
    if (!alpaca) return LOCAL_ASSETS;
    try {
      const remote = await alpaca.assets();
      const merged = [...remote];
      for (const asset of LOCAL_ASSETS) if (!merged.some((item) => item.symbol === asset.symbol)) merged.push(asset);
      return catalogCache.set("assets", merged, 30 * 60_000);
    } catch {
      return LOCAL_ASSETS;
    }
  }

  async function getQuote(symbol, { fresh = false } = {}) {
    const normalized = String(symbol || "").trim().toUpperCase();
    if (!(await catalog()).some((asset) => asset.symbol === normalized)) {
      throw new AppError("UNKNOWN_SYMBOL", `Unknown symbol: ${normalized}`, 404);
    }
    if (!fresh) {
      const cached = quoteCache.get(normalized);
      if (cached) return cached;
    }
    const { value } = await attempt("quote", normalized);
    return quoteCache.set(normalized, value, config.quoteCacheMs);
  }

  async function getBars(symbol, rangeKey = "1D") {
    const normalized = String(symbol || "").trim().toUpperCase();
    if (!(await catalog()).some((asset) => asset.symbol === normalized)) {
      throw new AppError("UNKNOWN_SYMBOL", `Unknown symbol: ${normalized}`, 404);
    }
    let range;
    try { range = getRangeConfig(rangeKey); }
    catch { throw new AppError("INVALID_RANGE", `Unsupported chart range: ${rangeKey}`, 400); }
    const key = `${normalized}:${range.key}`;
    const cached = barsCache.get(key);
    if (cached) return cached;
    const { value, provider } = await attempt("bars", normalized, range);
    const data = { symbol: normalized, range: range.key, interval: range.interval, source: provider, bars: value, diagnostics: diagnostics(value) };
    const ttl = ["1H", "1D"].includes(range.key) ? config.barsCacheIntradayMs : config.barsCacheLongMs;
    return barsCache.set(key, data, ttl);
  }

  async function search(query, { withQuotes = false, limit = 20 } = {}) {
    const assets = searchCatalog(await catalog(), query, limit);
    if (!withQuotes) return assets;
    return Promise.all(assets.map(async (asset) => {
      try { return { ...asset, quote: await getQuote(asset.symbol) }; }
      catch (error) {
        return { ...asset, quote: { symbol: asset.symbol, status: "unavailable", source: "unavailable", error: error.message, checkedAt: Date.now() } };
      }
    }));
  }

  async function movers() {
    const assets = await search("", { withQuotes: true, limit: 60 });
    return assets.sort((a, b) => Math.abs(b.quote?.changePercent || 0) - Math.abs(a.quote?.changePercent || 0));
  }

  async function selectionUniverse({ source = "auto", limit = 100 } = {}) {
    const requested = String(source).toLowerCase();
    const cappedLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const cacheKey = `${requested}:${cappedLimit}`;
    const cached = selectionUniverseCache.get(cacheKey);
    if (cached) return cached;

    const local = async (fallback = false) => {
      const assets = await catalog();
      return selectionUniverseCache.set(cacheKey, {
        symbols: assets.slice(0, cappedLimit).map((asset) => asset.symbol),
        source: "local-catalogue",
        forwardTestOnly: false,
        fallback,
        survivorshipWarning: null
      }, 5 * 60_000);
    };
    if (requested === "local") return local(false);

    const alpaca = providers.find((provider) => provider.id === "alpaca");
    if (!alpaca?.configured() || typeof alpaca.mostActives !== "function") return local(true);
    try {
      const symbols = await alpaca.mostActives({ limit: cappedLimit });
      if (symbols.length === 0) throw new Error("Alpaca most-actives screener returned no symbols.");
      return selectionUniverseCache.set(cacheKey, {
        symbols,
        source: "alpaca-most-actives",
        // This list is sampled today. It must not be turned into a historical
        // backtest universe: doing so selects on information at the end of the window.
        forwardTestOnly: true,
        fallback: false,
        survivorshipWarning: "Live screen universes omit delisted names and are forward-test-only; do not use them to claim historical performance."
      }, 5 * 60_000);
    } catch {
      return local(true);
    }
  }

  function markForwardTestOnly(symbols) {
    for (const symbol of symbols ?? []) forwardTestOnlySymbols.add(String(symbol).trim().toUpperCase());
  }

  function assertBacktestAllowed(symbol) {
    const normalized = String(symbol).trim().toUpperCase();
    if (forwardTestOnlySymbols.has(normalized)) {
      throw new AppError(
        "FORWARD_TEST_ONLY",
        `${normalized} came from a current live screen and is forward-test-only; historical backtesting would introduce look-ahead bias.`,
        422
      );
    }
  }

  function providerHealth() {
    return providers.map((provider) => {
      const current = health.get(provider.id);
      const configured = provider.configured();
      return {
        ...current,
        configured,
        status: configured ? current.status === "unconfigured" ? "unknown" : current.status : "unconfigured",
        message: configured ? current.message === "Credentials not configured" ? "Not checked yet" : current.message : "Credentials not configured"
      };
    });
  }

  async function testProviders(symbol = "SPY") {
    await Promise.all(providers.map(async (provider) => {
      if (!provider.configured()) return;
      const started = Date.now();
      try {
        await provider.quote(symbol);
        health.set(provider.id, {
          ...health.get(provider.id),
          status: "healthy",
          lastSuccessAt: Date.now(),
          latencyMs: Date.now() - started,
          message: `Real ${symbol} quote received`
        });
      } catch (error) {
        health.set(provider.id, {
          ...health.get(provider.id),
          status: "degraded",
          lastErrorAt: Date.now(),
          latencyMs: Date.now() - started,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }));
    return providerHealth();
  }

  return {
    getQuote,
    getBars,
    search,
    movers,
    selectionUniverse,
    markForwardTestOnly,
    assertBacktestAllowed,
    providerHealth,
    testProviders,
    clearCaches: () => { quoteCache.clear(); barsCache.clear(); catalogCache.clear(); selectionUniverseCache.clear(); }
  };
}
