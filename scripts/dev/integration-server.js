#!/usr/bin/env node
/**
 * Integration server — the REAL Stockbot API with a SYNTHETIC market provider.
 *
 * `createStockbot()` already accepts an injected `market`, so this needs no changes to
 * any server source. Everything above the provider boundary is the production code path:
 * migrations, repositories, the algorithm registry, the plugin loader, the engine worker
 * pool, the result cache, HTTP routing, auth middleware, serializers, the supervisor,
 * the paper broker and the risk engine.
 *
 * What it replaces is only `server/market/chain.js` — the layer that would otherwise make
 * HTTPS calls to Alpaca, Polygon or Finnhub. In its place is a deterministic universe of
 * eight symbols with deliberately different characteristics, so the selector has
 * something real to rank and the gates have something real to exclude.
 *
 * Every bar this serves is fabricated. Nothing it produces is evidence about any real
 * security. Point DATABASE_URL at a scratch file before running it — the point is to
 * exercise the automation, not to write synthetic fills into a real ledger.
 *
 *   DATABASE_URL=file:/tmp/sb/test.db PORT=4111 STOCKBOT_API_TOKEN=… \
 *     node scripts/dev/integration-server.js
 */
import process from "node:process";

import { createStockbot } from "../../server/bootstrap.js";
import { getRangeConfig } from "../../packages/shared/ranges.js";

/**
 * Eight synthetic symbols spanning the axes the selector scores on. The point is that a
 * ranking over this universe is falsifiable: if THIN or PENNY ever appears in the
 * recommended list, a gate is broken; if FLAT outranks MEGA, the volatility band is.
 */
const UNIVERSE = Object.freeze([
  { symbol: "MEGA", name: "Megacap Synthetic", sector: "Synthetic", price: 240, drift: 0.0009, vol: 0.018, dollarVolume: 1_500_000_000, bars: 900 },
  { symbol: "STEADY", name: "Steady Synthetic", sector: "Synthetic", price: 96, drift: 0.0004, vol: 0.008, dollarVolume: 420_000_000, bars: 900 },
  { symbol: "WILD", name: "Volatile Synthetic", sector: "Synthetic", price: 61, drift: 0.0002, vol: 0.055, dollarVolume: 300_000_000, bars: 900 },
  { symbol: "FLAT", name: "Rangebound Synthetic", sector: "Synthetic", price: 150, drift: 0.00001, vol: 0.002, dollarVolume: 260_000_000, bars: 900 },
  { symbol: "CYCLE", name: "Cyclical Synthetic", sector: "Synthetic", price: 78, drift: 0.0006, vol: 0.026, dollarVolume: 180_000_000, bars: 900, cycle: 40 },
  { symbol: "THIN", name: "Illiquid Synthetic", sector: "Synthetic", price: 44, drift: 0.0005, vol: 0.03, dollarVolume: 2_000_000, bars: 900 },
  { symbol: "PENNY", name: "Sub-dollar Synthetic", sector: "Synthetic", price: 2.4, drift: 0.001, vol: 0.05, dollarVolume: 90_000_000, bars: 900 },
  { symbol: "NEWCO", name: "Recent Listing Synthetic", sector: "Synthetic", price: 33, drift: 0.002, vol: 0.03, dollarVolume: 500_000_000, bars: 40 },
  { symbol: "SPY", name: "Synthetic Index Proxy", sector: "Synthetic", price: 520, drift: 0.0004, vol: 0.009, dollarVolume: 30_000_000_000, bars: 900 }
]);

/** SplitMix32, seeded per symbol so every process serves byte-identical history. */
function rng(seed) {
  let counter = seed >>> 0 || 1;
  return () => {
    counter = (counter + 0x9e3779b9) >>> 0;
    let mixed = counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    return ((mixed ^ (mixed >>> 15)) >>> 0) / 4294967296;
  };
}

function seedOf(symbol) {
  let hash = 2166136261;
  for (const character of symbol) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return hash;
}

function generate(spec, count, intervalMs, endTime) {
  const next = rng(seedOf(spec.symbol));
  const gaussian = () => {
    const u1 = Math.max(1e-9, next());
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * next());
  };
  const total = Math.min(count, spec.bars);
  const bars = [];
  let price = spec.price;
  for (let index = 0; index < total; index += 1) {
    const open = price;
    const cyclical = spec.cycle ? Math.sin((index / spec.cycle) * Math.PI * 2) * spec.vol * 0.9 : 0;
    price = Math.max(0.05, price * (1 + spec.drift + cyclical + spec.vol * gaussian()));
    const close = Number(price.toFixed(4));
    const wick = Math.abs(close - open) * 0.5 + close * spec.vol * 0.25 * next();
    bars.push({
      time: endTime - (total - 1 - index) * intervalMs,
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) + wick).toFixed(4)),
      low: Number(Math.max(0.01, Math.min(open, close) - wick).toFixed(4)),
      close,
      volume: Math.max(1, Math.round(spec.dollarVolume / close * (0.75 + next() * 0.5)))
    });
  }
  return bars;
}

function createSyntheticMarket() {
  const specs = new Map(UNIVERSE.map((entry) => [entry.symbol, entry]));
  // Anchored to a fixed instant so bar timestamps — and therefore the backtest cache key
  // — are stable for the life of the process. A moving "now" would make every repeated
  // call a cache miss and hide the caching behaviour this harness is meant to observe.
  const endTime = Date.UTC(2026, 7, 21);
  const catalogue = UNIVERSE.map(({ symbol, name, sector }) => ({ symbol, name, sector, aliases: [], tradable: true }));

  function requireSpec(symbol) {
    const normalized = String(symbol || "").trim().toUpperCase();
    const spec = specs.get(normalized);
    if (!spec) {
      const error = new Error(`Unknown symbol: ${normalized}`);
      error.code = "UNKNOWN_SYMBOL";
      error.status = 404;
      throw error;
    }
    return spec;
  }

  async function getBars(symbol, rangeKey = "1D") {
    const spec = requireSpec(symbol);
    const range = getRangeConfig(rangeKey);
    // Honour range.limit exactly as the real provider chain does. A harness that quietly
    // served 900 bars for every range would hide the fact that "1Y" is 80 weekly bars.
    const bars = generate(spec, range.limit, Math.max(range.key === "ALL" ? 2_629_746_000 : 86_400_000, 60_000), endTime);
    return {
      symbol: spec.symbol,
      range: range.key,
      interval: range.interval,
      source: "synthetic",
      bars,
      diagnostics: { rsi: null, emaFast: null, emaSlow: null, atr: null, vwap: null }
    };
  }

  async function getQuote(symbol) {
    const spec = requireSpec(symbol);
    const bars = generate(spec, 2, 86_400_000, endTime);
    const last = bars.at(-1);
    const previous = bars[0];
    return {
      symbol: spec.symbol,
      price: last.close,
      previousClose: previous.close,
      change: Number((last.close - previous.close).toFixed(4)),
      changePercent: Number((((last.close - previous.close) / previous.close) * 100).toFixed(4)),
      volume: last.volume,
      source: "synthetic",
      status: "ok",
      quoteTime: last.time,
      checkedAt: Date.now()
    };
  }

  async function search(query, { withQuotes = false, limit = 20 } = {}) {
    const text = String(query || "").trim().toUpperCase();
    const matches = catalogue.filter((asset) => !text || asset.symbol.includes(text) || asset.name.toUpperCase().includes(text)).slice(0, limit);
    if (!withQuotes) return matches;
    return Promise.all(matches.map(async (asset) => ({ ...asset, quote: await getQuote(asset.symbol) })));
  }

  return {
    getBars,
    getQuote,
    search,
    movers: async () => (await search("", { withQuotes: true, limit: 60 })).sort(
      (a, b) => Math.abs(b.quote.changePercent) - Math.abs(a.quote.changePercent)
    ),
    providerHealth: () => [{ id: "synthetic", configured: true, status: "healthy", lastSuccessAt: Date.now(), lastErrorAt: null, latencyMs: 0, message: "Synthetic provider — fabricated data" }],
    testProviders: async () => [{ id: "synthetic", configured: true, status: "healthy", message: "Synthetic provider — fabricated data" }],
    clearCaches: () => undefined
  };
}

const runtime = await createStockbot({ market: createSyntheticMarket() });
const server = runtime.app.listen(runtime.config.port, runtime.config.host, () => {
  process.stderr.write(`SYNTHETIC Stockbot API on http://${runtime.config.host}:${runtime.config.port} — fabricated market data\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    process.exit(0);
  });
}
