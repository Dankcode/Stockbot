import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 4000);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(workspaceRoot, ".env");
const algorithmsDir = path.join(workspaceRoot, "algorithms");
const algorithmUploadsDir = path.join(algorithmsDir, "uploads");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const symbols = [
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors", price: 217.83, previousClose: 214.86, volume: 5374242, aliases: ["nvidia", "gpu", "ai chips", "semiconductor", "chips", "jensen"] },
  { symbol: "AAPL", name: "Apple", sector: "Consumer Tech", price: 311.28, previousClose: 310.22, volume: 1230648, aliases: ["apple", "iphone", "mac", "ipad", "consumer tech"] },
  { symbol: "TSLA", name: "Tesla", sector: "EVs", price: 417.36, previousClose: 423.84, volume: 585863, aliases: ["tesla", "electric car", "ev", "elon", "model y", "auto"] },
  { symbol: "MSFT", name: "Microsoft", sector: "Cloud", price: 512.42, previousClose: 508.1, volume: 1425101, aliases: ["microsoft", "azure", "windows", "office", "cloud", "openai partner"] },
  { symbol: "AMD", name: "Advanced Micro Devices", sector: "Semiconductors", price: 166.72, previousClose: 161.34, volume: 2304412, aliases: ["amd", "advanced micro", "chips", "cpu", "gpu", "semiconductor"] },
  { symbol: "META", name: "Meta Platforms", sector: "Social", price: 683.25, previousClose: 674.8, volume: 984201, aliases: ["meta", "facebook", "instagram", "whatsapp", "social media", "zuckerberg"] },
  { symbol: "PLTR", name: "Palantir", sector: "Data Platforms", price: 147.44, previousClose: 139.21, volume: 4119202, aliases: ["palantir", "data", "analytics", "government software", "ai platform"] },
  { symbol: "SPY", name: "SPDR S&P 500 ETF", sector: "ETF", price: 756.16, previousClose: 754.18, volume: 1546700, aliases: ["spy", "s&p", "s&p 500", "sp500", "market index", "broad market", "etf"] },
  { symbol: "QQQ", name: "Invesco QQQ Trust", sector: "ETF", price: 612.58, previousClose: 606.74, volume: 1827741, aliases: ["qqq", "nasdaq", "nasdaq 100", "tech etf", "growth etf"] },
  { symbol: "HOOD", name: "Robinhood Markets", sector: "Brokerage", price: 92.34, previousClose: 89.52, volume: 778902, aliases: ["robinhood", "brokerage", "trading app", "retail trading", "paper trading"] },
  { symbol: "GOOGL", name: "Alphabet", sector: "Search & Ads", price: 286.14, previousClose: 282.31, volume: 1392230, aliases: ["google", "alphabet", "youtube", "search", "ads", "gemini", "android"] },
  { symbol: "AMZN", name: "Amazon", sector: "Commerce & Cloud", price: 241.62, previousClose: 238.4, volume: 1804420, aliases: ["amazon", "aws", "ecommerce", "online shopping", "cloud", "prime"] },
  { symbol: "NFLX", name: "Netflix", sector: "Streaming", price: 1260.8, previousClose: 1238.9, volume: 521840, aliases: ["netflix", "streaming", "movies", "tv", "entertainment"] },
  { symbol: "JPM", name: "JPMorgan Chase", sector: "Banking", price: 311.48, previousClose: 309.2, volume: 923120, aliases: ["jpmorgan", "jp morgan", "chase", "bank", "banking", "finance"] },
  { symbol: "BAC", name: "Bank of America", sector: "Banking", price: 51.36, previousClose: 50.84, volume: 1982140, aliases: ["bank of america", "bofa", "boa", "bank", "banking", "finance"] },
  { symbol: "XOM", name: "Exxon Mobil", sector: "Energy", price: 124.72, previousClose: 123.1, volume: 1148800, aliases: ["exxon", "exxonmobil", "oil", "gas", "energy", "petroleum"] },
  { symbol: "WMT", name: "Walmart", sector: "Retail", price: 108.44, previousClose: 107.72, volume: 1305520, aliases: ["walmart", "retail", "groceries", "supermarket", "consumer staples"] },
  { symbol: "DIS", name: "Disney", sector: "Entertainment", price: 118.92, previousClose: 119.5, volume: 871300, aliases: ["disney", "parks", "espn", "streaming", "movies", "entertainment"] },
  { symbol: "BA", name: "Boeing", sector: "Aerospace", price: 226.75, previousClose: 229.12, volume: 731920, aliases: ["boeing", "airplanes", "aerospace", "defense", "aircraft"] },
  { symbol: "COIN", name: "Coinbase", sector: "Crypto Brokerage", price: 302.18, previousClose: 294.45, volume: 1217780, aliases: ["coinbase", "crypto brokerage", "bitcoin exchange", "crypto exchange", "coin"] },
  { symbol: "BABA", name: "Alibaba Group", sector: "China ADR", price: 81.42, previousClose: 79.88, volume: 2948200, aliases: ["alibaba", "china ecommerce", "chinese stock", "adr", "taobao", "tmall", "cloud china"] },
  { symbol: "JD", name: "JD.com", sector: "China ADR", price: 34.18, previousClose: 33.72, volume: 1420340, aliases: ["jd", "jd.com", "jingdong", "china ecommerce", "chinese stock", "adr"] },
  { symbol: "PDD", name: "PDD Holdings", sector: "China ADR", price: 128.64, previousClose: 125.38, volume: 1680220, aliases: ["pdd", "pinduoduo", "temu", "china ecommerce", "chinese stock", "adr"] },
  { symbol: "NIO", name: "NIO", sector: "China EV", price: 5.72, previousClose: 5.48, volume: 7032840, aliases: ["nio", "china ev", "electric car", "chinese stock", "adr"] },
  { symbol: "BTCUSD", name: "Bitcoin USD", sector: "Crypto", price: 104250.12, previousClose: 102980.4, volume: 3512040, aliases: ["bitcoin", "btc", "btc usd", "btc/usd", "crypto", "cryptocurrency", "digital gold"] },
  { symbol: "ETHUSD", name: "Ethereum USD", sector: "Crypto", price: 3842.18, previousClose: 3765.54, volume: 2841020, aliases: ["ethereum", "eth", "eth usd", "eth/usd", "crypto", "smart contracts"] },
  { symbol: "SOLUSD", name: "Solana USD", sector: "Crypto", price: 186.72, previousClose: 181.3, volume: 1642080, aliases: ["solana", "sol", "sol usd", "sol/usd", "crypto", "layer 1"] },
  { symbol: "DOGEUSD", name: "Dogecoin USD", sector: "Crypto", price: 0.216, previousClose: 0.209, volume: 5231040, aliases: ["dogecoin", "doge", "doge usd", "doge/usd", "meme coin", "crypto"] },
  { symbol: "BRK.B", name: "Berkshire Hathaway", sector: "Holding Company", price: 527.6, previousClose: 524.18, volume: 815420, aliases: ["berkshire", "berkshire hathaway", "warren buffett", "brk b", "insurance"] },
  { symbol: "AVGO", name: "Broadcom", sector: "Semiconductors", price: 288.22, previousClose: 281.76, volume: 2180840, aliases: ["broadcom", "chips", "semiconductor", "networking", "vmware"] },
  { symbol: "COST", name: "Costco", sector: "Retail", price: 1018.4, previousClose: 1007.55, volume: 410220, aliases: ["costco", "warehouse", "retail", "consumer staples"] },
  { symbol: "UNH", name: "UnitedHealth", sector: "Healthcare", price: 325.4, previousClose: 329.12, volume: 960530, aliases: ["unitedhealth", "healthcare", "insurance", "health insurance"] },
  { symbol: "ORCL", name: "Oracle", sector: "Cloud", price: 181.72, previousClose: 178.6, volume: 1459820, aliases: ["oracle", "database", "cloud", "enterprise software"] },
  { symbol: "CRM", name: "Salesforce", sector: "Enterprise Software", price: 292.18, previousClose: 287.42, volume: 870440, aliases: ["salesforce", "crm", "enterprise software", "saas"] },
  { symbol: "UBER", name: "Uber", sector: "Mobility", price: 93.86, previousClose: 91.3, volume: 1652100, aliases: ["uber", "rideshare", "taxi", "delivery", "mobility"] },
  { symbol: "NKE", name: "Nike", sector: "Apparel", price: 72.44, previousClose: 73.02, volume: 990180, aliases: ["nike", "shoes", "apparel", "sportswear"] },
  { symbol: "PFE", name: "Pfizer", sector: "Pharmaceuticals", price: 25.72, previousClose: 25.34, volume: 2140020, aliases: ["pfizer", "pharma", "vaccine", "medicine", "healthcare"] }
];

const account = {
  cash: 100000,
  buyingPower: 100000,
  realizedPnl: 0,
  orders: [],
  positions: {}
};

const assetCatalogCache = {
  loadedAt: 0,
  source: "local",
  items: []
};
const quoteCache = new Map();
const quoteCacheTtlMs = 30000;
const barsCache = new Map();

function barsCacheTtlMs(range) {
  return range === "1H" || range === "1D" ? 60000 : 5 * 60000;
}
const settingGroups = [
  {
    id: "alpaca",
    label: "Alpaca paper trading",
    fields: [
      { key: "ALPACA_API_KEY", label: "API key", secret: true, placeholder: "PK..." },
      { key: "ALPACA_API_SECRET", label: "API secret", secret: true, placeholder: "Secret key" },
      { key: "ALPACA_PAPER_BASE_URL", label: "Paper base URL", defaultValue: "https://paper-api.alpaca.markets" },
      { key: "ALPACA_DATA_BASE_URL", label: "Market data URL", defaultValue: "https://data.alpaca.markets" },
      { key: "ALPACA_STOCK_FEED", label: "Stock data feed", defaultValue: "iex" },
      { key: "ALPACA_ASSET_CACHE_TTL_MS", label: "Asset cache TTL", defaultValue: "1800000" }
    ]
  },
  {
    id: "marketData",
    label: "Historical market data fallbacks",
    fields: [
      { key: "POLYGON_API_KEY", label: "Polygon API key", secret: true, placeholder: "Polygon key" },
      { key: "FINNHUB_API_KEY", label: "Finnhub API key", secret: true, placeholder: "Finnhub key" }
    ]
  },
  {
    id: "openai",
    label: "OpenAI strategy research",
    fields: [
      { key: "OPENAI_API_KEY", label: "API key", secret: true, placeholder: "sk-..." },
      { key: "OPENAI_BASE_URL", label: "Base URL", defaultValue: "https://api.openai.com/v1" }
    ]
  },
  {
    id: "server",
    label: "Local server",
    fields: [
      { key: "PORT", label: "API port", defaultValue: "4000" },
      { key: "STOCKBOT_MODE", label: "Mode", defaultValue: "local-paper" }
    ]
  }
];

function assetCacheTtlMs() {
  return Number(process.env.ALPACA_ASSET_CACHE_TTL_MS ?? 1000 * 60 * 30);
}

function symbolSeed(symbol) {
  return Array.from(symbol).reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

function enrichCatalogAsset(asset, index) {
  const existing = symbols.find((item) => item.symbol === asset.symbol);
  const seeded = symbolSeed(asset.symbol) + index * 17;
  const basePrice = 18 + (seeded % 420) + (seeded % 97) / 100;
  const previousClose = basePrice + ((seeded % 37) - 18) / 7;

  return {
    symbol: asset.symbol,
    name: asset.name || asset.symbol,
    sector: asset.sector || asset.exchange || asset.assetClass || "Alpaca Asset",
    price: existing?.price ?? Number(basePrice.toFixed(2)),
    previousClose: existing?.previousClose ?? Number(previousClose.toFixed(2)),
    volume: existing?.volume ?? 120000 + (seeded % 9200000),
    aliases: existing?.aliases ?? [asset.name, asset.exchange, asset.assetClass, asset.status].filter(Boolean),
    exchange: asset.exchange,
    status: asset.status,
    tradable: asset.tradable
  };
}

function localAssetCatalog() {
  return symbols.map((asset, index) => enrichCatalogAsset(asset, index));
}

function readEnvFile() {
  if (!fs.existsSync(envPath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(envPath));
}

function settingValue(field, envValues) {
  return envValues[field.key] ?? process.env[field.key] ?? field.defaultValue ?? "";
}

function maskSecret(value) {
  if (!value) {
    return "";
  }
  const visible = String(value).slice(-4);
  return `Saved (${String(value).length > 4 ? "..." : ""}${visible})`;
}

function getSettingsPayload() {
  const envValues = readEnvFile();
  return {
    envFilePresent: fs.existsSync(envPath),
    groups: settingGroups.map((group) => ({
      ...group,
      fields: group.fields.map((field) => {
        const value = settingValue(field, envValues);
        return {
          key: field.key,
          label: field.label,
          secret: Boolean(field.secret),
          placeholder: field.secret ? field.placeholder : undefined,
          value: field.secret ? "" : value,
          hasValue: Boolean(value),
          maskedValue: field.secret ? maskSecret(value) : undefined
        };
      })
    }))
  };
}

function serializeEnv(values) {
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? "").replace(/\n/g, "")}`)
    .join("\n")}\n`;
}

function saveSettings(updates) {
  const envValues = readEnvFile();
  const allowedFields = new Map(settingGroups.flatMap((group) => group.fields.map((field) => [field.key, field])));

  for (const [key, rawValue] of Object.entries(updates ?? {})) {
    const field = allowedFields.get(key);
    if (!field) {
      continue;
    }
    const value = String(rawValue ?? "").trim();
    if (field.secret && value === "") {
      continue;
    }
    envValues[key] = value;
    process.env[key] = value;
  }

  fs.writeFileSync(envPath, serializeEnv(envValues));
  assetCatalogCache.loadedAt = 0;
  assetCatalogCache.source = "local";
  assetCatalogCache.items = [];
  quoteCache.clear();
}

async function loadAssetCatalog() {
  const now = Date.now();
  const hasFreshCache = assetCatalogCache.items.length > 0 && now - assetCatalogCache.loadedAt < assetCacheTtlMs();
  if (hasFreshCache) {
    return assetCatalogCache;
  }

  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  const baseUrl = process.env.ALPACA_PAPER_BASE_URL ?? "https://paper-api.alpaca.markets";

  if (!key || !secret) {
    assetCatalogCache.loadedAt = now;
    assetCatalogCache.source = "local";
    assetCatalogCache.items = localAssetCatalog();
    return assetCatalogCache;
  }

  try {
    const headers = {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret
    };
    const remoteAssets = (
      await Promise.all(
        ["us_equity", "crypto"].map(async (assetClass) => {
          const url = new URL("/v2/assets", baseUrl);
          url.searchParams.set("asset_class", assetClass);
          url.searchParams.set("status", "active");
          const response = await fetch(url, { headers });

          if (!response.ok) {
            throw new Error(`Alpaca ${assetClass} assets request failed: ${response.status}`);
          }

          return response.json();
        })
      )
    ).flat();
    const seenSymbols = new Set();
    const merged = remoteAssets
      .filter((asset) => asset.symbol && asset.name)
      .filter((asset) => {
        if (seenSymbols.has(asset.symbol)) {
          return false;
        }
        seenSymbols.add(asset.symbol);
        return true;
      })
      .map((asset, index) =>
        enrichCatalogAsset(
          {
            symbol: asset.symbol,
            name: asset.name,
            sector: asset.exchange,
            exchange: asset.exchange,
            assetClass: asset.class,
            status: asset.status,
            tradable: asset.tradable
          },
          index
        )
      );

    for (const fallback of localAssetCatalog()) {
      if (!merged.some((asset) => asset.symbol === fallback.symbol)) {
        merged.push(fallback);
      }
    }

    assetCatalogCache.loadedAt = now;
    assetCatalogCache.source = "alpaca";
    assetCatalogCache.items = merged;
    return assetCatalogCache;
  } catch (error) {
    console.warn(error.message);
    assetCatalogCache.loadedAt = now;
    assetCatalogCache.source = "local";
    assetCatalogCache.items = localAssetCatalog();
    return assetCatalogCache;
  }
}

function priceDecimals(reference) {
  const value = Math.abs(Number(reference));
  if (value < 1) {
    return 4;
  }
  if (value < 10) {
    return 3;
  }
  return 2;
}

function roundPrice(value, reference = value) {
  const decimals = priceDecimals(reference);
  return Number(Number(value).toFixed(decimals));
}

function normalizeCandle(candle, referencePrice) {
  const open = roundPrice(candle.open, referencePrice);
  const close = roundPrice(candle.close, referencePrice);
  const high = roundPrice(Math.max(candle.high, open, close), referencePrice);
  const low = roundPrice(Math.min(candle.low, open, close), referencePrice);

  return {
    ...candle,
    open,
    high,
    low,
    close,
    volume: Math.max(0, Math.round(candle.volume))
  };
}

function getStats(asset, price, changePercent) {
  return {
    marketCap: price * (asset.symbol === "SPY" || asset.symbol === "QQQ" ? 940000000 : 15500000000),
    avgVolume: Math.round(asset.volume * 0.84),
    beta: Number((0.85 + Math.abs(changePercent) / 5).toFixed(2)),
    peRatio: asset.sector === "ETF" ? null : Number((24 + changePercent * 1.7).toFixed(2))
  };
}

function getCandles(asset, index, currentPrice) {
  const candles = [];
  let lastClose = asset.previousClose;
  const precisionAnchor = Math.min(asset.previousClose, currentPrice);

  for (let point = 0; point < 79; point += 1) {
    const rhythm = Math.sin(point / 5 + index * 1.7) * 0.008;
    const micro = Math.cos(point / 2.8 + index) * 0.004;
    const trend = ((currentPrice - asset.previousClose) / asset.previousClose) * (point / 78);
    const open = lastClose;
    const close = roundPrice(asset.previousClose * (1 + rhythm + micro + trend), precisionAnchor);
    const spread = Math.max(asset.previousClose * (0.0025 + Math.abs(rhythm) * 0.45), asset.previousClose * 0.0008, 0.0001);
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread;

    const totalMinutes = 9 * 60 + 30 + point * 5;
    candles.push(normalizeCandle({
      time: `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, "0")}`,
      open,
      high,
      low,
      close,
      volume: Math.round((asset.volume / 96) * (0.7 + Math.abs(rhythm) * 40))
    }, precisionAnchor));
    lastClose = close;
  }

  candles[candles.length - 1].close = currentPrice;
  candles[candles.length - 1].high = Math.max(candles[candles.length - 1].high, currentPrice);
  candles[candles.length - 1].low = Math.min(candles[candles.length - 1].low, currentPrice);
  return candles.map((candle) => normalizeCandle(candle, precisionAnchor));
}

function getDiagnostics(candles) {
  const last = candles[candles.length - 1];
  const emaFast = candles.slice(-9).reduce((sum, candle) => sum + candle.close, 0) / 9;
  const emaSlow = candles.slice(-21).reduce((sum, candle) => sum + candle.close, 0) / 21;
  const vwapNumerator = candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0);
  const vwapDenominator = candles.reduce((sum, candle) => sum + candle.volume, 0) || 1;
  const ranges = candles.slice(-14).map((candle) => candle.high - candle.low);
  const atr = ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
  const gains = candles.slice(-14).filter((candle) => candle.close >= candle.open).length;
  const rsi = 38 + (gains / 14) * 38 + Math.min(Math.max((last.close - emaSlow) / atr, -4), 4) * 2.2;
  const signalScore = 50 + ((emaFast - emaSlow) / atr) * 12 + (last.close > vwapNumerator / vwapDenominator ? 8 : -8);

  return {
    rsi: Number(Math.max(0, Math.min(100, rsi)).toFixed(1)),
    emaFast: Number(emaFast.toFixed(2)),
    emaSlow: Number(emaSlow.toFixed(2)),
    vwap: Number((vwapNumerator / vwapDenominator).toFixed(2)),
    atr: Number(atr.toFixed(2)),
    signalScore: Number(Math.max(0, Math.min(100, signalScore)).toFixed(1))
  };
}

function rangeBacktestConfig(range = "1Y") {
  const configs = {
    "1H": { days: 3, timeframe: "1Min", polygonMultiplier: 1, polygonTimespan: "minute", finnhubResolution: "1", limit: 60 },
    "1D": { days: 7, timeframe: "5Min", polygonMultiplier: 5, polygonTimespan: "minute", finnhubResolution: "5", limit: 78 },
    "1W": { days: 14, timeframe: "1Hour", polygonMultiplier: 1, polygonTimespan: "hour", finnhubResolution: "60", limit: 180 },
    "1M": { days: 45, timeframe: "1Day", polygonMultiplier: 1, polygonTimespan: "day", finnhubResolution: "D", limit: 60 },
    "3M": { days: 120, timeframe: "1Day", polygonMultiplier: 1, polygonTimespan: "day", finnhubResolution: "D", limit: 140 },
    "1Y": { days: 420, timeframe: "1Week", polygonMultiplier: 1, polygonTimespan: "week", finnhubResolution: "W", limit: 80 },
    ALL: { days: 3650, timeframe: "1Month", polygonMultiplier: 1, polygonTimespan: "month", finnhubResolution: "M", limit: 140 }
  };
  return configs[range] ?? configs["1Y"];
}

function alpacaHeaders() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) {
    return null;
  }
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret
  };
}

function isCryptoSymbol(symbol) {
  const normalized = String(symbol).toUpperCase();
  return normalized.includes("/") || ["BTCUSD", "ETHUSD", "SOLUSD", "DOGEUSD"].includes(normalized);
}

function cryptoPair(symbol) {
  const normalized = String(symbol).toUpperCase();
  return normalized.includes("/") ? normalized : normalized.replace("USD", "/USD");
}

function quoteCacheKey(symbol) {
  return String(symbol).toUpperCase();
}

function getCachedQuote(symbol) {
  const cached = quoteCache.get(quoteCacheKey(symbol));
  if (!cached || Date.now() - cached.cachedAt > quoteCacheTtlMs) {
    return null;
  }
  if (cached.error) {
    throw cached.error;
  }
  return cached.quote;
}

function setCachedQuote(symbol, quote) {
  quoteCache.set(quoteCacheKey(symbol), { cachedAt: Date.now(), quote });
}

function setCachedQuoteError(symbol, error) {
  quoteCache.set(quoteCacheKey(symbol), { cachedAt: Date.now(), error });
}

function ensureQuoteNumbers(symbol, quote, source) {
  const price = Number(quote.price);
  const previousClose = Number(quote.previousClose);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0) {
    throw new Error(`${source} returned an invalid quote for ${symbol}.`);
  }
  return {
    ...quote,
    price,
    previousClose,
    volume: Number.isFinite(Number(quote.volume)) ? Number(quote.volume) : 0,
    source
  };
}

async function fetchFinnhubQuote(symbol) {
  const apiKey = process.env.FINNHUB_API_KEY || process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error("Finnhub API key is not configured.");
  }
  if (isCryptoSymbol(symbol)) {
    throw new Error("Finnhub live quotes are configured for stocks only.");
  }

  const url = new URL("https://finnhub.io/api/v1/quote");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("token", apiKey);
  const finnhubResponse = await fetch(url);
  if (!finnhubResponse.ok) {
    throw new Error(`Finnhub quote failed: ${finnhubResponse.status}`);
  }
  const payload = await finnhubResponse.json();
  return ensureQuoteNumbers(symbol, {
    price: payload.c,
    previousClose: payload.pc || payload.o,
    volume: 0,
    quoteTime: payload.t ? new Date(payload.t * 1000).toISOString() : new Date().toISOString()
  }, "finnhub-quote");
}

async function fetchAlpacaSnapshotQuote(symbol) {
  const headers = alpacaHeaders();
  if (!headers) {
    throw new Error("Alpaca credentials are not configured.");
  }

  const dataBaseUrl = process.env.ALPACA_DATA_BASE_URL ?? "https://data.alpaca.markets";
  const url = isCryptoSymbol(symbol)
    ? new URL("/v1beta3/crypto/us/snapshots", dataBaseUrl)
    : new URL(`/v2/stocks/${symbol}/snapshot`, dataBaseUrl);

  if (isCryptoSymbol(symbol)) {
    url.searchParams.set("symbols", cryptoPair(symbol));
  } else {
    url.searchParams.set("feed", process.env.ALPACA_STOCK_FEED ?? "iex");
  }

  const alpacaResponse = await fetch(url, { headers });
  if (!alpacaResponse.ok) {
    throw new Error(`Alpaca snapshot failed: ${alpacaResponse.status}`);
  }
  const payload = await alpacaResponse.json();
  const snapshot = isCryptoSymbol(symbol) ? payload.snapshots?.[cryptoPair(symbol)] : payload;
  if (!snapshot) {
    throw new Error("Alpaca returned no snapshot.");
  }

  return ensureQuoteNumbers(symbol, {
    price: snapshot.latestTrade?.p ?? snapshot.minuteBar?.c ?? snapshot.dailyBar?.c,
    previousClose: snapshot.prevDailyBar?.c ?? snapshot.dailyBar?.o,
    volume: snapshot.dailyBar?.v ?? snapshot.minuteBar?.v ?? 0,
    quoteTime: snapshot.latestTrade?.t ?? snapshot.minuteBar?.t ?? snapshot.dailyBar?.t ?? new Date().toISOString()
  }, isCryptoSymbol(symbol) ? "alpaca-crypto-snapshot" : "alpaca-stock-snapshot");
}

async function fetchPolygonPreviousClose(symbol) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    throw new Error("Polygon API key is not configured.");
  }
  if (isCryptoSymbol(symbol)) {
    throw new Error("Polygon quote fallback is configured for stocks only.");
  }

  const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev`);
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("apiKey", apiKey);
  const polygonResponse = await fetch(url);
  if (!polygonResponse.ok) {
    throw new Error(`Polygon previous close failed: ${polygonResponse.status}`);
  }
  const payload = await polygonResponse.json();
  const bar = payload.results?.[0];
  if (!bar) {
    throw new Error(payload.error || "Polygon returned no previous close.");
  }
  return ensureQuoteNumbers(symbol, {
    price: bar.c,
    previousClose: bar.o || bar.c,
    volume: bar.v,
    quoteTime: bar.t ? new Date(bar.t).toISOString() : new Date().toISOString()
  }, "polygon-previous-close");
}

async function fetchRealQuote(symbol) {
  const cached = getCachedQuote(symbol);
  if (cached) {
    return cached;
  }

  const attempts = isCryptoSymbol(symbol)
    ? [() => fetchAlpacaSnapshotQuote(symbol)]
    : [() => fetchAlpacaSnapshotQuote(symbol), () => fetchFinnhubQuote(symbol), () => fetchPolygonPreviousClose(symbol)];
  const errors = [];

  for (const attempt of attempts) {
    try {
      const quote = await attempt();
      setCachedQuote(symbol, quote);
      return quote;
    } catch (error) {
      errors.push(error.message);
    }
  }

  const error = new Error(`Real quote unavailable for ${symbol}. ${errors.join(" ")}`);
  setCachedQuoteError(symbol, error);
  throw error;
}

function toIsoDate(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString();
}

function toDateOnly(daysAgo) {
  return toIsoDate(daysAgo).slice(0, 10);
}

function unixSeconds(daysAgo) {
  return Math.floor(new Date(toIsoDate(daysAgo)).getTime() / 1000);
}

function normalizeHistoricalBar(bar, symbol) {
  const reference = bar.c ?? bar.close;
  return normalizeCandle({
    time: String(bar.t ?? bar.Timestamp ?? bar.timestamp ?? ""),
    open: Number(bar.o ?? bar.open),
    high: Number(bar.h ?? bar.high),
    low: Number(bar.l ?? bar.low),
    close: Number(bar.c ?? bar.close),
    volume: Number(bar.v ?? bar.volume ?? 0)
  }, reference || symbols.find((asset) => asset.symbol === symbol)?.price || 1);
}

async function fetchAlpacaHistoricalBars(symbol, range) {
  const headers = alpacaHeaders();
  if (!headers) {
    const error = new Error("Alpaca credentials are required for real historical backtests.");
    error.statusCode = 503;
    throw error;
  }

  const config = rangeBacktestConfig(range);
  const dataBaseUrl = process.env.ALPACA_DATA_BASE_URL ?? "https://data.alpaca.markets";
  const url = isCryptoSymbol(symbol)
    ? new URL("/v1beta3/crypto/us/bars", dataBaseUrl)
    : new URL(`/v2/stocks/${symbol}/bars`, dataBaseUrl);

  if (isCryptoSymbol(symbol)) {
    url.searchParams.set("symbols", cryptoPair(symbol));
  } else {
    url.searchParams.set("feed", process.env.ALPACA_STOCK_FEED ?? "iex");
    url.searchParams.set("adjustment", "split");
  }
  url.searchParams.set("timeframe", config.timeframe);
  url.searchParams.set("start", toIsoDate(config.days));
  url.searchParams.set("end", new Date().toISOString());
  url.searchParams.set("limit", String(config.limit));
  url.searchParams.set("sort", "desc");

  const alpacaResponse = await fetch(url, { headers });
  if (!alpacaResponse.ok) {
    const error = new Error(`Alpaca historical bars failed: ${alpacaResponse.status}`);
    error.statusCode = alpacaResponse.status;
    throw error;
  }

  const payload = await alpacaResponse.json();
  const rawBars = isCryptoSymbol(symbol) ? payload.bars?.[cryptoPair(symbol)] ?? [] : payload.bars ?? [];
  const bars = rawBars
    .map((bar) => normalizeHistoricalBar(bar, symbol))
    .filter((bar) => Number.isFinite(bar.close))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  if (bars.length === 0) {
    throw new Error("Alpaca returned no historical bars.");
  }
  return { source: "alpaca-historical", bars };
}

async function fetchPolygonHistoricalBars(symbol, range) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    throw new Error("Polygon API key is not configured.");
  }
  if (isCryptoSymbol(symbol)) {
    throw new Error("Polygon fallback is currently configured for stock bars only.");
  }

  const config = rangeBacktestConfig(range);
  const ticker = encodeURIComponent(symbol);
  const url = new URL(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${config.polygonMultiplier}/${config.polygonTimespan}/${toDateOnly(config.days)}/${toDateOnly(0)}`);
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", String(Math.max(config.limit, 5000)));
  url.searchParams.set("apiKey", apiKey);

  const polygonResponse = await fetch(url);
  if (!polygonResponse.ok) {
    throw new Error(`Polygon historical bars failed: ${polygonResponse.status}`);
  }
  const payload = await polygonResponse.json();
  const rawBars = payload.results ?? [];
  const bars = rawBars
    .map((bar) =>
      normalizeHistoricalBar({
        t: new Date(bar.t).toISOString(),
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v
      }, symbol)
    )
    .filter((bar) => Number.isFinite(bar.close))
    .slice(-config.limit);

  if (bars.length === 0) {
    throw new Error(payload.error || "Polygon returned no historical bars.");
  }
  return { source: "polygon-historical", bars };
}

async function fetchFinnhubHistoricalBars(symbol, range) {
  const apiKey = process.env.FINNHUB_API_KEY || process.env.NEXT_PUBLIC_FINNHUB_API_KEY;
  if (!apiKey) {
    throw new Error("Finnhub API key is not configured.");
  }
  if (isCryptoSymbol(symbol)) {
    throw new Error("Finnhub fallback is currently configured for stock bars only.");
  }

  const config = rangeBacktestConfig(range);
  const url = new URL("https://finnhub.io/api/v1/stock/candle");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("resolution", config.finnhubResolution);
  url.searchParams.set("from", String(unixSeconds(config.days)));
  url.searchParams.set("to", String(unixSeconds(0)));
  url.searchParams.set("token", apiKey);

  const finnhubResponse = await fetch(url);
  if (!finnhubResponse.ok) {
    throw new Error(`Finnhub historical bars failed: ${finnhubResponse.status}`);
  }
  const payload = await finnhubResponse.json();
  if (payload.s !== "ok") {
    throw new Error(payload.error || `Finnhub returned status ${payload.s || "unknown"}.`);
  }

  const bars = payload.t
    .map((timestamp, index) =>
      normalizeHistoricalBar({
        t: new Date(timestamp * 1000).toISOString(),
        o: payload.o[index],
        h: payload.h[index],
        l: payload.l[index],
        c: payload.c[index],
        v: payload.v[index]
      }, symbol)
    )
    .filter((bar) => Number.isFinite(bar.close))
    .slice(-config.limit);

  if (bars.length === 0) {
    throw new Error("Finnhub returned no historical bars.");
  }
  return { source: "finnhub-historical", bars };
}

async function fetchHistoricalBars(symbol, range) {
  const attempts = [
    () => fetchAlpacaHistoricalBars(symbol, range),
    () => fetchPolygonHistoricalBars(symbol, range),
    () => fetchFinnhubHistoricalBars(symbol, range)
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      errors.push(error.message);
    }
  }

  const error = new Error(`Historical bars unavailable. Tried Alpaca, Polygon, and Finnhub. ${errors.join(" ")}`);
  error.statusCode = 503;
  throw error;
}

async function fetchCachedHistoricalBars(symbol, range) {
  const cacheKey = `${String(symbol).toUpperCase()}:${range}`;
  const cached = barsCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < barsCacheTtlMs(range)) {
    if (cached.error) {
      throw cached.error;
    }
    return cached.data;
  }

  try {
    const data = await fetchHistoricalBars(symbol, range);
    barsCache.set(cacheKey, { cachedAt: Date.now(), data });
    return data;
  } catch (error) {
    barsCache.set(cacheKey, { cachedAt: Date.now(), error });
    throw error;
  }
}

function emaSeries(values, period) {
  const multiplier = 2 / (period + 1);
  let previous = values[0];
  return values.map((value, index) => {
    previous = index === 0 ? value : value * multiplier + previous * (1 - multiplier);
    return previous;
  });
}

function backtestStockbotMomentum(symbol, bars, startingCash = 100000) {
  const closes = bars.map((bar) => bar.close);
  const fast = emaSeries(closes, 9);
  const slow = emaSeries(closes, 21);
  let cash = startingCash;
  let qty = 0;
  let entryPrice = 0;
  const trades = [];
  const equityCurve = [];

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousFast = fast[index - 1];
    const previousSlow = slow[index - 1];
    const crossedUp = previousFast <= previousSlow && fast[index] > slow[index];
    const crossedDown = previousFast >= previousSlow && fast[index] < slow[index];
    const warmupEntry = index === 21 && fast[index] > slow[index];
    const stopLoss = qty > 0 && bar.close <= entryPrice * 0.92;

    if (qty === 0 && index >= 21 && (crossedUp || warmupEntry)) {
      const notional = cash * 0.95;
      qty = notional / bar.close;
      cash -= notional;
      entryPrice = bar.close;
      trades.push({
        id: `${symbol}-stockbot-${index}-buy`,
        time: bar.time,
        side: "buy",
        price: bar.close,
        quantity: Number(qty.toFixed(4)),
        rule: warmupEntry ? "EMA9 already above EMA21 after historical warmup" : "EMA9 crossed above EMA21 on historical bars",
        confidence: Number(Math.min(95, 55 + ((fast[index] - slow[index]) / bar.close) * 2400).toFixed(1)),
        pnlPercent: 0
      });
    } else if (qty > 0 && (crossedDown || stopLoss)) {
      const proceeds = qty * bar.close;
      const pnlPercent = ((bar.close - entryPrice) / entryPrice) * 100;
      cash += proceeds;
      trades.push({
        id: `${symbol}-stockbot-${index}-sell`,
        time: bar.time,
        side: "sell",
        price: bar.close,
        quantity: Number(qty.toFixed(4)),
        rule: stopLoss ? "Historical stop loss triggered" : "EMA9 crossed below EMA21 on historical bars",
        confidence: Number(Math.min(95, 55 + Math.abs((fast[index] - slow[index]) / bar.close) * 2400).toFixed(1)),
        pnlPercent: Number(pnlPercent.toFixed(2))
      });
      qty = 0;
      entryPrice = 0;
    }

    const equity = cash + qty * bar.close;
    equityCurve.push({
      time: bar.time,
      equity: Number(equity.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      positionValue: Number((qty * bar.close).toFixed(2))
    });
  }

  if (qty > 0 && bars.length > 0) {
    const finalBar = bars[bars.length - 1];
    const proceeds = qty * finalBar.close;
    const pnlPercent = ((finalBar.close - entryPrice) / entryPrice) * 100;
    cash += proceeds;
    trades.push({
      id: `${symbol}-stockbot-final-sell`,
      time: finalBar.time,
      side: "sell",
      price: finalBar.close,
      quantity: Number(qty.toFixed(4)),
      rule: "Backtest window ended; position closed for realized simulation",
      confidence: 50,
      pnlPercent: Number(pnlPercent.toFixed(2))
    });
    qty = 0;
    equityCurve.push({
      time: finalBar.time,
      equity: Number(cash.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      positionValue: 0
    });
  }

  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? startingCash;
  return {
    trades,
    equityCurve,
    metrics: {
      startingCash,
      finalEquity,
      returnPercent: Number((((finalEquity - startingCash) / startingCash) * 100).toFixed(2)),
      tradeCount: trades.length,
      openPosition: qty > 0
    }
  };
}

function smaSeries(values, period) {
  return values.map((_, index) => {
    const sample = values.slice(Math.max(0, index - period + 1), index + 1);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  });
}

function rsiSeries(values, period = 14) {
  let avgGain = 0;
  let avgLoss = 0;
  return values.map((value, index) => {
    if (index === 0) {
      return 50;
    }
    const change = value - values[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      avgGain = (avgGain * (index - 1) + gain) / index;
      avgLoss = (avgLoss * (index - 1) + loss) / index;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) {
      return avgGain === 0 ? 50 : 100;
    }
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  });
}

function trueRangeSeries(bars) {
  return bars.map((bar, index) => {
    if (index === 0) {
      return bar.high - bar.low;
    }
    const previousClose = bars[index - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
}

function atrSeries(bars, period = 14) {
  const ranges = trueRangeSeries(bars);
  let previous = ranges[0];
  return ranges.map((value, index) => {
    previous = index === 0 ? value : (previous * (period - 1) + value) / period;
    return previous;
  });
}

function rollingExtreme(bars, period, pick, field) {
  return bars.map((bar, index) => {
    const sample = bars.slice(Math.max(0, index - period), index).map((item) => item[field]);
    return sample.length > 0 ? pick(...sample) : bar[field];
  });
}

function createIndicators(bars) {
  const closes = bars.map((bar) => bar.close);
  const cache = new Map();
  const memo = (key, compute) => {
    if (!cache.has(key)) {
      cache.set(key, compute());
    }
    return cache.get(key);
  };

  return {
    closes,
    ema: (period) => memo(`ema:${period}`, () => emaSeries(closes, period)),
    sma: (period) => memo(`sma:${period}`, () => smaSeries(closes, period)),
    rsi: (period = 14) => memo(`rsi:${period}`, () => rsiSeries(closes, period)),
    atr: (period = 14) => memo(`atr:${period}`, () => atrSeries(bars, period)),
    highestHigh: (period) => memo(`hh:${period}`, () => rollingExtreme(bars, period, Math.max, "high")),
    lowestLow: (period) => memo(`ll:${period}`, () => rollingExtreme(bars, period, Math.min, "low"))
  };
}

function runAlgorithmBacktest(bars, algorithm, startingCash = 100000) {
  const indicators = createIndicators(bars);
  const closes = indicators.closes;
  const params = algorithm.params ?? {};
  let state = {};
  if (typeof algorithm.init === "function") {
    state = algorithm.init({ bars, closes, params, indicators }) ?? {};
  }

  let cash = startingCash;
  let qty = 0;
  let entryPrice = 0;
  let entryIndex = -1;
  let wins = 0;
  let sells = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let pnlPercentSum = 0;
  let barsInPosition = 0;
  let peak = startingCash;
  let maxDrawdown = 0;
  let lastSignal = null;
  const trades = [];
  const equityCurve = [{ time: bars[0]?.time ?? "", equity: startingCash }];

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const signal = algorithm.signal({
      index,
      bar,
      bars,
      closes,
      state,
      params,
      indicators,
      position: { qty, entryPrice, entryIndex }
    });
    if (index === bars.length - 1) {
      lastSignal = signal ?? null;
    }

    if (signal === "buy" && qty === 0) {
      const notional = cash * 0.95;
      qty = notional / bar.close;
      cash -= notional;
      entryPrice = bar.close;
      entryIndex = index;
      trades.push({
        id: `${algorithm.name}-${index}-buy`,
        time: bar.time,
        side: "buy",
        price: bar.close,
        quantity: Number(qty.toFixed(4)),
        rule: `${algorithm.name} entry signal`,
        pnlPercent: 0
      });
    } else if (signal === "sell" && qty > 0) {
      const proceeds = qty * bar.close;
      const pnl = proceeds - entryPrice * qty;
      const pnlPercent = ((bar.close - entryPrice) / entryPrice) * 100;
      cash += proceeds;
      sells += 1;
      pnlPercentSum += pnlPercent;
      if (pnl >= 0) {
        wins += 1;
        grossWin += pnl;
      } else {
        grossLoss += Math.abs(pnl);
      }
      trades.push({
        id: `${algorithm.name}-${index}-sell`,
        time: bar.time,
        side: "sell",
        price: bar.close,
        quantity: Number(qty.toFixed(4)),
        rule: `${algorithm.name} exit signal`,
        pnlPercent: Number(pnlPercent.toFixed(2))
      });
      qty = 0;
      entryPrice = 0;
      entryIndex = -1;
    }

    if (qty > 0) {
      barsInPosition += 1;
    }
    const equity = cash + qty * bar.close;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, ((equity - peak) / peak) * 100);
    equityCurve.push({ time: bar.time, equity: Number(equity.toFixed(2)) });
  }

  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? startingCash;
  const periodReturns = equityCurve.slice(1).map((point, index) => point.equity / equityCurve[index].equity - 1);
  const meanReturn = periodReturns.reduce((sum, value) => sum + value, 0) / Math.max(periodReturns.length, 1);
  const variance =
    periodReturns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / Math.max(periodReturns.length - 1, 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  return {
    trades,
    lastSignal,
    equityCurve,
    metrics: {
      returnPercent: Number((((finalEquity - startingCash) / startingCash) * 100).toFixed(2)),
      finalEquity,
      tradeCount: trades.length,
      winRate: sells > 0 ? Number(((wins / sells) * 100).toFixed(1)) : null,
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      sharpe: Number(sharpe.toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 1,
      exposurePercent: Number(((barsInPosition / Math.max(bars.length - 1, 1)) * 100).toFixed(1)),
      avgTradePercent: sells > 0 ? Number((pnlPercentSum / sells).toFixed(2)) : 0,
      openPosition: qty > 0
    }
  };
}

function validateAlgorithm(algorithm, file) {
  if (!algorithm || typeof algorithm !== "object") {
    throw new Error(`${file} has no default export. Export a default object — see algorithms/README.md.`);
  }
  if (typeof algorithm.name !== "string" || algorithm.name.trim() === "") {
    throw new Error(`${file} is missing a "name" string.`);
  }
  if (typeof algorithm.signal !== "function") {
    throw new Error(`${file} is missing a "signal" function.`);
  }
}

const algorithmCache = { loadedAt: 0, items: [], errors: [] };
const algorithmCacheTtlMs = 15000;
const algorithmParamsPath = path.join(algorithmsDir, "params.json");

function readParamOverrides() {
  try {
    return JSON.parse(fs.readFileSync(algorithmParamsPath, "utf8"));
  } catch {
    return {};
  }
}

function saveParamOverrides(overrides) {
  fs.mkdirSync(algorithmsDir, { recursive: true });
  fs.writeFileSync(algorithmParamsPath, `${JSON.stringify(overrides, null, 2)}\n`);
}

async function loadAlgorithms(force = false) {
  const now = Date.now();
  if (!force && now - algorithmCache.loadedAt < algorithmCacheTtlMs) {
    return algorithmCache;
  }

  const items = [];
  const errors = [];
  const overrides = readParamOverrides();
  const sources = [
    { dir: algorithmsDir, uploaded: false },
    { dir: algorithmUploadsDir, uploaded: true }
  ];

  for (const source of sources) {
    if (!fs.existsSync(source.dir)) {
      continue;
    }
    for (const file of fs.readdirSync(source.dir).sort()) {
      if (!file.endsWith(".js")) {
        continue;
      }
      const fullPath = path.join(source.dir, file);
      try {
        const stat = fs.statSync(fullPath);
        const module = await import(`${pathToFileURL(fullPath).href}?v=${stat.mtimeMs}`);
        const algorithm = module.default;
        validateAlgorithm(algorithm, file);
        const id = `${source.uploaded ? "uploads/" : ""}${file.replace(/\.js$/, "")}`;
        const defaultParams = algorithm.params ?? {};
        items.push({
          id,
          file: path.relative(workspaceRoot, fullPath),
          uploaded: source.uploaded,
          name: algorithm.name,
          author: typeof algorithm.author === "string" ? algorithm.author : undefined,
          description: typeof algorithm.description === "string" ? algorithm.description : undefined,
          defaultParams,
          params: { ...defaultParams, ...(overrides[id] ?? {}) },
          signal: algorithm.signal,
          init: algorithm.init
        });
      } catch (error) {
        errors.push({ file: path.relative(workspaceRoot, fullPath), error: error.message });
      }
    }
  }

  algorithmCache.loadedAt = now;
  algorithmCache.items = items;
  algorithmCache.errors = errors;
  return algorithmCache;
}

function publicAlgorithms(loaded) {
  return {
    algorithms: loaded.items.map((item) => ({
      id: item.id,
      name: item.name,
      author: item.author,
      description: item.description,
      params: item.params,
      defaultParams: item.defaultParams,
      file: item.file,
      uploaded: item.uploaded
    })),
    errors: loaded.errors
  };
}

const controlAlgorithms = {
  spyHold: { name: "S&P 500 Index (SPY)", signal: ({ index }) => (index === 1 ? "buy" : null) },
  cash: { name: "Cash", signal: () => null }
};


function getAlgorithmTrades(asset, candles, index) {
  const tradePoints = [
    { candleIndex: 12 + (index % 4), side: "buy", rule: "EMA9 crossed above EMA21 with rising volume" },
    { candleIndex: 31 + (index % 5), side: "sell", rule: "Momentum cooled below VWAP guardrail" },
    { candleIndex: 47 + (index % 6), side: "buy", rule: "Breakout retest held above signal band" },
    { candleIndex: 67 + (index % 4), side: "sell", rule: "Profit lock triggered after ATR extension" }
  ];
  let entryPrice = null;

  return tradePoints.map((point, tradeIndex) => {
    const candle = candles[Math.min(point.candleIndex, candles.length - 1)];
    const price = point.side === "buy" ? candle.close : candle.open;
    const pnlPercent = point.side === "sell" && entryPrice ? ((price - entryPrice) / entryPrice) * 100 : 0;
    if (point.side === "buy") {
      entryPrice = price;
    }
    return {
      id: `${asset.symbol}-${tradeIndex + 1}`,
      time: candle.time,
      side: point.side,
      price: Number(price.toFixed(2)),
      quantity: 5 + ((index + tradeIndex) % 4) * 3,
      rule: point.rule,
      confidence: Number((58 + Math.abs(Math.sin(index + tradeIndex)) * 31).toFixed(1)),
      pnlPercent: Number(pnlPercent.toFixed(2))
    };
  });
}

function normalizeSearch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function fuzzyIncludes(text, query) {
  let cursor = 0;
  for (const character of query) {
    cursor = text.indexOf(character, cursor);
    if (cursor === -1) {
      return false;
    }
    cursor += 1;
  }
  return true;
}

function scoreSearchMatch(asset, query) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) {
    return { score: Math.abs(asset.changePercent), reason: "mover" };
  }

  const symbol = normalizeSearch(asset.symbol);
  const name = normalizeSearch(asset.name);
  const sector = normalizeSearch(asset.sector);
  const aliases = asset.aliases ?? [];
  const fields = [
    { value: symbol, label: "symbol" },
    { value: name, label: "company" },
    { value: sector, label: "sector" },
    ...aliases.map((alias) => ({ value: normalizeSearch(alias), label: alias }))
  ];
  const queryTerms = normalizedQuery.split(" ").filter(Boolean);
  let score = 0;
  let reason = "";

  for (const field of fields) {
    if (field.value === normalizedQuery) {
      return { score: 140, reason: `matched ${field.label}` };
    }
    if (field.value.startsWith(normalizedQuery)) {
      score = Math.max(score, 105);
      reason ||= `starts with ${field.label}`;
    }
    if (field.value.includes(normalizedQuery)) {
      score = Math.max(score, 86);
      reason ||= `contains ${field.label}`;
    }
    const termMatches = queryTerms.filter((term) => field.value.includes(term)).length;
    if (termMatches > 0) {
      score = Math.max(score, 34 + termMatches * 18);
      reason ||= `matched ${field.label}`;
    }
    if (normalizedQuery.length >= 3 && fuzzyIncludes(field.value, normalizedQuery)) {
      score = Math.max(score, 30);
      reason ||= `fuzzy matched ${field.label}`;
    }
  }

  return { score, reason };
}

function catalogMove(asset) {
  return Math.abs(((asset.price - asset.previousClose) / asset.previousClose) * 100);
}

async function searchMarket(query, limit = 12) {
  const catalog = await loadAssetCatalog();
  const ranked = catalog.items
    .map((asset) => {
      const match = scoreSearchMatch(asset, query);
      return { ...asset, matchReason: match.reason, searchScore: match.score };
    })
    .filter((asset) => !normalizeSearch(query) || asset.searchScore > 0)
    .sort((a, b) => b.searchScore - a.searchScore || catalogMove(b) - catalogMove(a))
    .slice(0, limit);

  return getQuotedMarket(ranked).then((assets) => assets.map((asset, index) => ({ ...asset, matchReason: ranked[index].matchReason })));
}

function buildMarketAsset(asset, index, quote) {
  const price = roundPrice(quote.price, quote.price);
  const previousClose = roundPrice(quote.previousClose, price);
  const volume = quote.volume > 0 ? Math.round(quote.volume) : asset.volume;
  const quotedAsset = {
    ...asset,
    previousClose,
    volume
  };
  const change = price - previousClose;
  const changePercent = (change / previousClose) * 100;
  const roundedChangePercent = Number(changePercent.toFixed(2));
  const candles = getCandles(quotedAsset, index, price);
  const diagnostics = getDiagnostics(candles);
  const algorithmTrades = getAlgorithmTrades(quotedAsset, candles, index);

  return {
    ...quotedAsset,
    price,
    change: roundPrice(change, price),
    changePercent: roundedChangePercent,
    stats: getStats(quotedAsset, price, roundedChangePercent),
    candles,
    algorithmTrades,
    diagnostics,
    dataStatus: "real",
    dataSource: quote.source,
    quoteTime: quote.quoteTime,
    spark: Array.from({ length: 34 }, (_, point) => {
      const drift = Math.sin(point / 4 + index) * 0.018;
      const trend = (point - 16) * (changePercent / 10000);
      return roundPrice(previousClose * (1 + drift + trend), price);
    })
  };
}

function buildUnavailableAsset(asset, index, error) {
  const fallbackQuote = {
    price: asset.price,
    previousClose: asset.previousClose,
    volume: asset.volume,
    source: "unavailable"
  };
  const fallback = buildMarketAsset(asset, index, fallbackQuote);
  return {
    ...fallback,
    change: 0,
    changePercent: 0,
    dataStatus: "error",
    dataSource: "unavailable",
    dataError: error.message,
    algorithmTrades: []
  };
}

async function getQuotedMarket(catalog = localAssetCatalog()) {
  return Promise.all(
    catalog.map(async (asset, index) => {
      try {
        return buildMarketAsset(asset, index, await fetchRealQuote(asset.symbol));
      } catch (error) {
        return buildUnavailableAsset(asset, index, error);
      }
    })
  );
}

function findCatalogAsset(catalog, symbol) {
  const normalizedSymbol = String(symbol ?? "").toUpperCase();
  return catalog.items.find((asset) => asset.symbol.toUpperCase() === normalizedSymbol);
}

async function getAsset(symbol) {
  const catalog = await loadAssetCatalog();
  const catalogAsset = findCatalogAsset(catalog, symbol);
  if (!catalogAsset) {
    return null;
  }

  const [asset] = await getQuotedMarket([catalogAsset]);
  return asset;
}

async function getPortfolio() {
  const positions = await Promise.all(Object.values(account.positions).map(async (position) => {
    const asset = await getAsset(position.symbol);
    if (!asset || asset.dataStatus !== "real") {
      const costBasis = position.avgPrice * position.qty;
      return {
        ...position,
        price: position.avgPrice,
        marketValue: Number(costBasis.toFixed(2)),
        unrealizedPnl: 0,
        unrealizedPnlPercent: 0,
        dataStatus: "error",
        dataError: asset?.dataError || "Real quote unavailable for this position."
      };
    }
    const marketValue = asset.price * position.qty;
    const costBasis = position.avgPrice * position.qty;
    const unrealizedPnl = marketValue - costBasis;
    return {
      ...position,
      price: asset.price,
      marketValue: Number(marketValue.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      unrealizedPnlPercent: Number(((unrealizedPnl / costBasis) * 100).toFixed(2))
    };
  }));

  const equity = positions.reduce((sum, position) => sum + position.marketValue, account.cash);
  return {
    cash: Number(account.cash.toFixed(2)),
    buyingPower: Number(account.cash.toFixed(2)),
    equity: Number(equity.toFixed(2)),
    dayChange: Number((positions.reduce((sum, position) => sum + position.unrealizedPnl, 0) * 0.18).toFixed(2)),
    realizedPnl: Number(account.realizedPnl.toFixed(2)),
    positions,
    orders: account.orders.slice(0, 12)
  };
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, mode: "local-paper", assetSource: assetCatalogCache.source, assetCount: assetCatalogCache.items.length, at: new Date().toISOString() });
});

app.get("/api/settings", (_request, response) => {
  response.json({ data: getSettingsPayload() });
});

app.post("/api/settings", (request, response) => {
  saveSettings(request.body?.settings ?? {});
  response.json({ data: getSettingsPayload() });
});

app.post("/api/settings/test/alpaca", async (request, response) => {
  const key = String(request.body?.ALPACA_API_KEY || process.env.ALPACA_API_KEY || "");
  const secret = String(request.body?.ALPACA_API_SECRET || process.env.ALPACA_API_SECRET || "");
  const baseUrl = String(request.body?.ALPACA_PAPER_BASE_URL || process.env.ALPACA_PAPER_BASE_URL || "https://paper-api.alpaca.markets");

  if (!key || !secret) {
    response.status(400).json({ ok: false, error: "Alpaca API key and secret are required." });
    return;
  }

  try {
    const url = new URL("/v2/account", baseUrl);
    const alpacaResponse = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
      }
    });
    response.status(alpacaResponse.ok ? 200 : 400).json({ ok: alpacaResponse.ok, status: alpacaResponse.status });
  } catch (error) {
    response.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/market/movers", async (request, response) => {
  const query = String(request.query.query ?? "").trim();
  const catalog = await loadAssetCatalog();
  const market = (query ? await searchMarket(query, 12) : await getQuotedMarket(catalog.items.slice(0, 60)))
    .sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

  response.json({ data: market, meta: { source: catalog.source, assetCount: catalog.items.length } });
});

app.get("/api/market/search", async (request, response) => {
  const query = String(request.query.query ?? "").trim();
  const catalog = await loadAssetCatalog();
  response.json({ data: await searchMarket(query, 20), meta: { source: catalog.source, assetCount: catalog.items.length } });
});

app.get("/api/market/symbol/:symbol", async (request, response) => {
  const asset = await getAsset(request.params.symbol);
  if (!asset) {
    response.status(404).json({ error: "Unknown symbol" });
    return;
  }
  response.json({ data: asset });
});

app.get("/api/market/bars/:symbol", async (request, response) => {
  const symbol = String(request.params.symbol ?? "").toUpperCase();
  const range = String(request.query.range ?? "1D");

  try {
    const historical = await fetchCachedHistoricalBars(symbol, range);
    response.json({ data: { symbol, range, source: historical.source, bars: historical.bars } });
  } catch (error) {
    response.status(error.statusCode ?? 500).json({
      error: error.message,
      data: { symbol, range, source: "unavailable", bars: [] }
    });
  }
});

app.get("/api/compare/:symbol", async (request, response) => {
  const symbol = String(request.params.symbol ?? "").toUpperCase();
  const range = String(request.query.range ?? "1Y");

  try {
    const historical = await fetchCachedHistoricalBars(symbol, range);
    if (historical.bars.length < 5) {
      throw new Error("Not enough historical bars to compare strategies.");
    }

    let spyHistorical = null;
    if (symbol !== "SPY") {
      try {
        spyHistorical = await fetchCachedHistoricalBars("SPY", range);
      } catch {
        spyHistorical = null;
      }
    }

    const windowLength = spyHistorical
      ? Math.min(historical.bars.length, spyHistorical.bars.length)
      : historical.bars.length;
    const bars = historical.bars.slice(-windowLength);
    const loaded = await loadAlgorithms();
    const strategies = [];

    for (const algorithm of loaded.items) {
      try {
        const result = runAlgorithmBacktest(bars, algorithm);
        strategies.push({
          id: algorithm.id,
          name: algorithm.name,
          type: "primary",
          description: algorithm.description,
          source: algorithm.file,
          equityCurve: result.equityCurve,
          trades: result.trades,
          lastSignal: result.lastSignal,
          metrics: result.metrics
        });
      } catch (error) {
        strategies.push({
          id: algorithm.id,
          name: algorithm.name,
          type: "primary",
          source: algorithm.file,
          error: `Algorithm crashed during backtest: ${error.message}`,
          equityCurve: [],
          trades: [],
          metrics: null
        });
      }
    }

    const spyBars = spyHistorical ? spyHistorical.bars.slice(-windowLength) : bars;
    const spyHold = runAlgorithmBacktest(spyBars, controlAlgorithms.spyHold);
    strategies.push({
      id: "control/spy",
      name: "S&P 500 Index (SPY) — Control",
      type: "control",
      description: "Buy-and-hold the S&P 500 ETF over the same window. The benchmark every algorithm should beat.",
      equityCurve: spyHold.equityCurve,
      trades: [],
      metrics: spyHold.metrics
    });

    const cash = runAlgorithmBacktest(bars, controlAlgorithms.cash);
    strategies.push({
      id: "control/cash",
      name: "Cash — Control",
      type: "control",
      description: "Flat $100,000 baseline.",
      equityCurve: cash.equityCurve,
      trades: [],
      metrics: cash.metrics
    });

    response.json({
      data: {
        symbol,
        range,
        source: historical.source,
        startingCash: 100000,
        algorithmErrors: loaded.errors,
        strategies
      }
    });
  } catch (error) {
    response.status(error.statusCode ?? 500).json({
      error: error.message,
      data: { symbol, range, source: "unavailable", startingCash: 100000, algorithmErrors: [], strategies: [] }
    });
  }
});

app.get("/api/algorithms", async (_request, response) => {
  response.json({ data: publicAlgorithms(await loadAlgorithms(true)) });
});

app.post("/api/algorithms/params", async (request, response) => {
  const id = String(request.body?.id ?? "");
  const incoming = request.body?.params;
  const loaded = await loadAlgorithms(true);
  const algorithm = loaded.items.find((item) => item.id === id);

  if (!algorithm) {
    response.status(404).json({ error: `Unknown algorithm: ${id}` });
    return;
  }
  if (!incoming || typeof incoming !== "object") {
    response.status(400).json({ error: "params must be an object." });
    return;
  }

  const cleaned = {};
  for (const [key, rawValue] of Object.entries(incoming)) {
    if (!(key in algorithm.defaultParams)) {
      continue;
    }
    const defaultValue = algorithm.defaultParams[key];
    if (typeof defaultValue === "number") {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) {
        response.status(400).json({ error: `Parameter "${key}" must be a number.` });
        return;
      }
      cleaned[key] = value;
    } else {
      cleaned[key] = String(rawValue);
    }
  }

  const overrides = readParamOverrides();
  overrides[id] = cleaned;
  saveParamOverrides(overrides);
  response.json({ data: publicAlgorithms(await loadAlgorithms(true)) });
});

app.get("/api/algorithms/scan", async (request, response) => {
  const symbols = String(request.query.symbols ?? "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 10);
  const range = String(request.query.range ?? "3M");

  if (symbols.length === 0) {
    response.status(400).json({ error: "Provide symbols, e.g. ?symbols=AAPL,NVDA" });
    return;
  }

  const loaded = await loadAlgorithms();
  const barsBySymbol = {};
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        barsBySymbol[symbol] = (await fetchCachedHistoricalBars(symbol, range)).bars;
      } catch (error) {
        barsBySymbol[symbol] = { error: error.message };
      }
    })
  );

  const strategies = loaded.items.map((algorithm) => {
    const perSymbol = [];
    let totalPnl = 0;
    let returnSum = 0;
    let scored = 0;
    let profitable = 0;

    for (const symbol of symbols) {
      const bars = barsBySymbol[symbol];
      if (!Array.isArray(bars)) {
        perSymbol.push({ symbol, error: bars?.error ?? "Bars unavailable." });
        continue;
      }
      try {
        const result = runAlgorithmBacktest(bars, algorithm);
        const pnl = Number((result.metrics.finalEquity - 100000).toFixed(2));
        const lastTrade = result.trades[result.trades.length - 1] ?? null;
        const recommendation =
          result.lastSignal === "buy" && !result.metrics.openPosition
            ? "buy"
            : result.lastSignal === "sell" && result.metrics.openPosition
              ? "sell"
              : result.metrics.openPosition
                ? "hold"
                : "stand by";
        perSymbol.push({
          symbol,
          returnPercent: result.metrics.returnPercent,
          pnl,
          winRate: result.metrics.winRate,
          maxDrawdown: result.metrics.maxDrawdown,
          sharpe: result.metrics.sharpe,
          profitFactor: result.metrics.profitFactor,
          exposurePercent: result.metrics.exposurePercent,
          avgTradePercent: result.metrics.avgTradePercent,
          tradeCount: result.metrics.tradeCount,
          openPosition: result.metrics.openPosition,
          recommendation,
          lastAction: lastTrade ? { side: lastTrade.side, time: lastTrade.time, price: lastTrade.price } : null
        });
        totalPnl += pnl;
        returnSum += result.metrics.returnPercent;
        scored += 1;
        if (pnl > 0) {
          profitable += 1;
        }
      } catch (error) {
        perSymbol.push({ symbol, error: error.message });
      }
    }

    return {
      id: algorithm.id,
      name: algorithm.name,
      description: algorithm.description,
      totals: {
        pnl: Number(totalPnl.toFixed(2)),
        avgReturnPercent: scored > 0 ? Number((returnSum / scored).toFixed(2)) : 0,
        profitableSymbols: profitable,
        scoredSymbols: scored
      },
      perSymbol
    };
  });

  response.json({ data: { range, symbols, strategies, algorithmErrors: loaded.errors } });
});

app.post("/api/algorithms/upload", async (request, response) => {
  const rawName = String(request.body?.filename ?? "algorithm").trim();
  const code = String(request.body?.code ?? "");
  const safeName = rawName.replace(/\.js$/i, "").replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 64);

  if (!safeName) {
    response.status(400).json({ error: "Invalid file name." });
    return;
  }
  if (code.trim().length === 0 || code.length > 500000) {
    response.status(400).json({ error: "Algorithm file must be non-empty and under 500 KB." });
    return;
  }

  fs.mkdirSync(algorithmUploadsDir, { recursive: true });
  const fullPath = path.join(algorithmUploadsDir, `${safeName}.js`);
  fs.writeFileSync(fullPath, code);

  try {
    const module = await import(`${pathToFileURL(fullPath).href}?v=${Date.now()}`);
    validateAlgorithm(module.default, `${safeName}.js`);
  } catch (error) {
    fs.unlinkSync(fullPath);
    response.status(400).json({ error: `Algorithm rejected: ${error.message}` });
    return;
  }

  response.status(201).json({ data: publicAlgorithms(await loadAlgorithms(true)) });
});

app.get("/api/backtest/:symbol", async (request, response) => {
  const symbol = String(request.params.symbol ?? "").toUpperCase();
  const range = String(request.query.range ?? "1Y");

  try {
    const historical = await fetchCachedHistoricalBars(symbol, range);
    const bars = historical.bars;
    const backtest = backtestStockbotMomentum(symbol, bars);
    response.json({
      data: {
        symbol,
        range,
        source: historical.source,
        bars,
        ...backtest
      }
    });
  } catch (error) {
    response.status(error.statusCode ?? 500).json({
      error: error.message,
      data: {
        symbol,
        range,
        source: "unavailable",
        bars: [],
        trades: [],
        equityCurve: [],
        metrics: null
      }
    });
  }
});

app.get("/api/portfolio", async (_request, response) => {
  response.json({ data: await getPortfolio() });
});

app.post("/api/orders", async (request, response) => {
  const symbol = String(request.body.symbol ?? "").toUpperCase();
  const side = String(request.body.side ?? "buy").toLowerCase();
  const qty = Number(request.body.qty);
  const asset = await getAsset(symbol);

  if (!asset || !Number.isFinite(qty) || qty <= 0 || !["buy", "sell"].includes(side)) {
    response.status(400).json({ error: "Invalid paper order" });
    return;
  }
  if (asset.dataStatus !== "real") {
    response.status(503).json({ error: asset.dataError || "Real quote unavailable. Paper order was not filled." });
    return;
  }

  const notional = Number((qty * asset.price).toFixed(2));
  const existing = account.positions[symbol] ?? { symbol, qty: 0, avgPrice: 0 };

  if (side === "buy") {
    if (notional > account.cash) {
      response.status(400).json({ error: "Insufficient paper buying power" });
      return;
    }
    const totalCost = existing.avgPrice * existing.qty + notional;
    const nextQty = existing.qty + qty;
    account.positions[symbol] = {
      symbol,
      qty: Number(nextQty.toFixed(4)),
      avgPrice: Number((totalCost / nextQty).toFixed(2))
    };
    account.cash -= notional;
  } else {
    if (qty > existing.qty) {
      response.status(400).json({ error: "Cannot sell more than simulated holdings" });
      return;
    }
    account.realizedPnl += (asset.price - existing.avgPrice) * qty;
    const nextQty = Number((existing.qty - qty).toFixed(4));
    if (nextQty <= 0) {
      delete account.positions[symbol];
    } else {
      account.positions[symbol] = { ...existing, qty: nextQty };
    }
    account.cash += notional;
  }

  const order = {
    id: crypto.randomUUID(),
    symbol,
    side,
    qty,
    filledAvgPrice: asset.price,
    status: "filled",
    notional,
    submittedAt: new Date().toISOString()
  };
  account.orders.unshift(order);
  response.status(201).json({ data: { order, portfolio: await getPortfolio() } });
});

app.post("/api/failsafe/liquidate", async (_request, response) => {
  const openPositions = Object.values(account.positions);

  for (const position of openPositions) {
    const asset = await getAsset(position.symbol);
    if (!asset || asset.dataStatus !== "real") {
      continue;
    }
    const notional = Number((position.qty * asset.price).toFixed(2));
    account.realizedPnl += (asset.price - position.avgPrice) * position.qty;
    account.cash += notional;
    account.orders.unshift({
      id: crypto.randomUUID(),
      symbol: position.symbol,
      side: "sell",
      qty: position.qty,
      filledAvgPrice: asset.price,
      status: "filled",
      notional,
      submittedAt: new Date().toISOString()
    });
  }

  account.positions = {};
  response.json({ data: { portfolio: await getPortfolio(), closed: openPositions.length } });
});

app.get("/api/strategies", (_request, response) => {
  response.json({
    data: [
      {
        name: "Stockbot Momentum",
        type: "primary",
        returnPercent: 4.8,
        maxDrawdown: -2.1,
        winRate: 61,
        sharpe: 1.74,
        profitFactor: 1.42,
        trades: 38,
        exposurePercent: 72,
        avgTradePercent: 0.36
      },
      {
        name: "Volatility Squeeze",
        type: "primary",
        returnPercent: 3.2,
        maxDrawdown: -1.8,
        winRate: 58,
        sharpe: 1.31,
        profitFactor: 1.28,
        trades: 22,
        exposurePercent: 46,
        avgTradePercent: 0.41
      },
      {
        name: "Mean Reversion",
        type: "primary",
        returnPercent: 1.1,
        maxDrawdown: -2.6,
        winRate: 54,
        sharpe: 0.62,
        profitFactor: 1.08,
        trades: 44,
        exposurePercent: 61,
        avgTradePercent: 0.09
      },
      {
        name: "Breakout Reversal",
        type: "primary",
        returnPercent: -0.8,
        maxDrawdown: -3.4,
        winRate: 43,
        sharpe: -0.21,
        profitFactor: 0.86,
        trades: 31,
        exposurePercent: 55,
        avgTradePercent: -0.07
      },
      {
        name: "Buy and Hold SPY",
        type: "control",
        returnPercent: 2.7,
        maxDrawdown: -1.4,
        winRate: 53,
        sharpe: 0.98,
        profitFactor: 1.16,
        trades: 1,
        exposurePercent: 100,
        avgTradePercent: 2.7
      },
      {
        name: "Equal Weight Movers",
        type: "control",
        returnPercent: 1.9,
        maxDrawdown: -2.8,
        winRate: 49,
        sharpe: 0.52,
        profitFactor: 1.04,
        trades: 50,
        exposurePercent: 80,
        avgTradePercent: 0.04
      },
      {
        name: "RSI 30/70 Control",
        type: "control",
        returnPercent: -1.4,
        maxDrawdown: -4.1,
        winRate: 41,
        sharpe: -0.35,
        profitFactor: 0.78,
        trades: 27,
        exposurePercent: 38,
        avgTradePercent: -0.18
      },
      {
        name: "Cash",
        type: "control",
        returnPercent: 0,
        maxDrawdown: 0,
        winRate: 100,
        sharpe: 0,
        profitFactor: 1,
        trades: 0,
        exposurePercent: 0,
        avgTradePercent: 0
      }
    ]
  });
});

app.listen(port, () => {
  console.log(`Stockbot API listening on http://localhost:${port}`);
});
