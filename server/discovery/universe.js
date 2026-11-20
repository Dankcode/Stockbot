/**
 * Which listed stocks discovery may consider. Pure: every exclusion is counted
 * with a reason, so a surprisingly small universe can be explained.
 */
const COMMON = /^[A-Z]{1,5}$/;
const CLASS_SHARE = /^[A-Z]{1,4}\.[A-Z]$/;
const NOT_COMMON_STOCK = /\b(warrants?|rights?|units?|preferred|pref\.?|depositary shares? representing|notes? due|debentures?|% |trust preferred|subordinated|perpetual)\b/i;
const BLANK_CHECK = /\b(acquisition corp(oration)?|acquisition co\b|spac\b|capital acquisition)\b/i;
const FUND = /\b(etf|etn|fund|trust units?|index|portfolio|closed[- ]end)\b/i;

export const DEFAULT_UNIVERSE_RULES = Object.freeze({
  excludeSp500: true,
  excludeBlankCheck: true,
  allowClassShares: true,
  exchanges: ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"]
});

export function buildUniverse({ assets, directory, sp500 = [], rules = {} }) {
  const config = { ...DEFAULT_UNIVERSE_RULES, ...rules };
  const sp = new Set(sp500);
  // Other share classes of a member (BRK.A when BRK.B is listed, BF.A for BF.B) are the
  // same company, so they are excluded with it.
  const baseOf = (symbol) => symbol.split(".")[0];
  const spClassBases = new Set(sp500.filter((symbol) => symbol.includes(".")).map(baseOf));
  const allowedExchanges = new Set(config.exchanges);
  const excluded = {};
  const count = (reason) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  const members = [];
  for (const asset of assets) {
    const symbol = asset.symbol;
    const listing = directory.get(symbol);
    if (!asset.tradable) { count("not tradable on Alpaca"); continue; }
    if (!allowedExchanges.has(asset.exchange)) { count(asset.exchange === "OTC" ? "OTC" : "other exchange"); continue; }
    if (!(COMMON.test(symbol) || (config.allowClassShares && CLASS_SHARE.test(symbol)))) { count("not a common-stock symbol"); continue; }
    if (!listing) { count("not in the Nasdaq Trader directory"); continue; }
    if (listing.testIssue) { count("test issue"); continue; }
    if (listing.etf) { count("ETF"); continue; }
    if (listing.financialStatus && listing.financialStatus !== "N") { count("exchange deficiency flag"); continue; }
    const name = listing.name || asset.name;
    if (NOT_COMMON_STOCK.test(name)) { count("warrant, unit, right, note or preferred"); continue; }
    if (FUND.test(asset.name) && !/\binc\b|corp|holdings|ltd|plc|\bco\b|group/i.test(asset.name)) { count("fund or trust"); continue; }
    if (config.excludeBlankCheck && BLANK_CHECK.test(name)) { count("blank-check company (SPAC)"); continue; }
    if (config.excludeSp500 && sp.has(symbol)) { count("S&P 500 member"); continue; }
    if (config.excludeSp500 && symbol.includes(".") && (sp.has(baseOf(symbol)) || spClassBases.has(baseOf(symbol)))) { count("share class of an S&P 500 member"); continue; }
    members.push({ symbol, name: asset.name || listing.name, exchange: asset.exchange, fractionable: asset.fractionable });
  }
  return { members, excluded, considered: assets.length };
}

/** Average close and dollar volume per symbol over the stored grouped-daily rows. */
export function liquidityFrom(rowsByDate) {
  const stats = new Map();
  for (const rows of rowsByDate) {
    for (const row of rows) {
      const entry = stats.get(row.symbol) ?? { days: 0, dollarVolume: 0, close: null };
      entry.days += 1;
      entry.dollarVolume += Number(row.close) * Number(row.volume);
      entry.close = Number(row.close);
      stats.set(row.symbol, entry);
    }
  }
  for (const entry of stats.values()) entry.dollarVolume /= entry.days;
  return stats;
}
