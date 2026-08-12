export const LOCAL_ASSETS = Object.freeze([
  ["NVDA", "NVIDIA", "Semiconductors", ["gpu", "ai chips", "jensen"]],
  ["AAPL", "Apple", "Consumer technology", ["iphone", "mac", "ipad"]],
  ["TSLA", "Tesla", "Electric vehicles", ["ev", "electric car", "elon"]],
  ["MSFT", "Microsoft", "Cloud software", ["azure", "windows", "office"]],
  ["AMD", "Advanced Micro Devices", "Semiconductors", ["cpu", "gpu", "chips"]],
  ["META", "Meta Platforms", "Social media", ["facebook", "instagram", "whatsapp"]],
  ["PLTR", "Palantir", "Data platforms", ["analytics", "government software"]],
  ["SPY", "SPDR S&P 500 ETF", "ETF", ["s&p 500", "market index", "sp500"]],
  ["QQQ", "Invesco QQQ Trust", "ETF", ["nasdaq 100", "tech etf"]],
  ["GOOGL", "Alphabet", "Search & advertising", ["google", "youtube", "gemini"]],
  ["AMZN", "Amazon", "Commerce & cloud", ["aws", "ecommerce", "prime"]],
  ["JPM", "JPMorgan Chase", "Banking", ["chase", "bank", "finance"]],
  ["XOM", "Exxon Mobil", "Energy", ["oil", "gas", "petroleum"]],
  ["BTCUSD", "Bitcoin USD", "Crypto", ["bitcoin", "btc", "digital gold"]],
  ["ETHUSD", "Ethereum USD", "Crypto", ["ethereum", "eth", "smart contracts"]],
  ["SOLUSD", "Solana USD", "Crypto", ["solana", "sol", "layer 1"]],
  ["DOGEUSD", "Dogecoin USD", "Crypto", ["dogecoin", "doge", "meme coin"]]
].map(([symbol, name, sector, aliases]) => ({ symbol, name, sector, aliases })));

function normalize(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function fuzzy(text, query) {
  let cursor = 0;
  for (const character of query) {
    cursor = text.indexOf(character, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

export function searchCatalog(items, rawQuery, limit = 20) {
  const query = normalize(rawQuery);
  if (!query) return items.slice(0, limit);
  const terms = query.split(" ");
  return items
    .map((asset) => {
      const fields = [asset.symbol, asset.name, asset.sector, ...(asset.aliases || [])].map(normalize);
      let score = 0;
      let reason = "";
      fields.forEach((field, index) => {
        if (field === query) { score = Math.max(score, 140); reason ||= index === 0 ? "symbol" : "exact match"; }
        else if (field.startsWith(query)) { score = Math.max(score, 105); reason ||= "prefix match"; }
        else if (field.includes(query)) { score = Math.max(score, 86); reason ||= "text match"; }
        else {
          const count = terms.filter((term) => field.includes(term)).length;
          if (count) { score = Math.max(score, 34 + count * 18); reason ||= "term match"; }
          if (query.length >= 3 && fuzzy(field, query)) { score = Math.max(score, 30); reason ||= "fuzzy match"; }
        }
      });
      return { ...asset, score, matchReason: reason };
    })
    .filter((asset) => asset.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, limit)
    .map(({ score: _score, ...asset }) => asset);
}

export function isCryptoSymbol(symbol) {
  const normalized = String(symbol).toUpperCase();
  return normalized.includes("/") || ["BTCUSD", "ETHUSD", "SOLUSD", "DOGEUSD"].includes(normalized);
}

export function cryptoPair(symbol) {
  const normalized = String(symbol).toUpperCase();
  return normalized.includes("/") ? normalized : normalized.replace(/USD$/, "/USD");
}
