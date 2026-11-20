import assert from "node:assert/strict";
import test from "node:test";

import { barMetrics, scoreCandidates } from "../../server/discovery/scoring.js";
import { buildUniverse, liquidityFrom } from "../../server/discovery/universe.js";
import { LISTINGS, makeBars } from "./fixtures.js";

const directory = new Map(LISTINGS.map((listing) => [listing.symbol, { name: listing.name, exchange: listing.exchange, etf: Boolean(listing.etf), testIssue: Boolean(listing.testIssue), financialStatus: "N" }]));
const assets = LISTINGS.map((listing) => ({ symbol: listing.symbol, name: listing.name, exchange: listing.exchange, tradable: true }));

test("the universe excludes the S&P 500, ETFs, warrants, SPACs, OTC and test issues, and counts why", () => {
  const universe = buildUniverse({ assets: [...assets, { symbol: "HALT", name: "Halted Inc", exchange: "NYSE", tradable: false }, { symbol: "ABC.PR", name: "ABC Preferred", exchange: "NYSE", tradable: true }], directory, sp500: ["NVDA"] });
  assert.deepEqual(universe.members.map((member) => member.symbol).sort(), ["GROW", "NEWCO", "PENNY", "SLOW", "STDY", "THIN", "TINY"]);
  assert.deepEqual(universe.excluded, {
    "S&P 500 member": 1, ETF: 1, "warrant, unit, right, note or preferred": 1, "blank-check company (SPAC)": 1,
    OTC: 1, "test issue": 1, "not tradable on Alpaca": 1, "not a common-stock symbol": 1
  });
  assert.ok(buildUniverse({ assets, directory, sp500: ["NVDA"], rules: { excludeSp500: false } }).members.some((member) => member.symbol === "NVDA"),
    "the S&P filter can be switched off");
});

test("liquidity averages dollar volume over the stored days a symbol traded", () => {
  const stats = liquidityFrom([[{ symbol: "A", close: 10, volume: 100 }], [{ symbol: "A", close: 20, volume: 100 }, { symbol: "B", close: 5, volume: 10 }]]);
  assert.deepEqual(stats.get("A"), { days: 2, dollarVolume: 1_500, close: 20 });
  assert.deepEqual(stats.get("B"), { days: 1, dollarVolume: 50, close: 5 });
});

test("bar metrics measure momentum, trend, volatility and drawdown from daily bars", () => {
  const rising = barMetrics(makeBars({ drift: 0.003, wiggle: 0.002 }));
  const falling = barMetrics(makeBars({ drift: -0.003, wiggle: 0.002 }));
  assert.ok(rising.mom12m > 0.5 && rising.trend === true && rising.aboveSma200 === true);
  assert.ok(falling.mom12m < -0.3 && falling.trend === false && falling.maxDrawdown1y < -0.3);
  const young = barMetrics(makeBars({ days: 40 }));
  assert.equal(young.mom12_1, null, "momentum that needs a year of history is missing, not zero");
  assert.equal(barMetrics([]), null);
});

test("scores rank growth and quality separately; missing inputs lower coverage instead of the score", () => {
  const candidate = (symbol, bars, fundamentals = {}) => ({ symbol, inputs: { ...barMetrics(makeBars(bars)), ...fundamentals } });
  const scored = scoreCandidates([
    candidate("GROW", { drift: 0.004, wiggle: 0.01 }, { revenueGrowthTTM: 60, revenueGrowth3Y: 45, netMarginTTM: 8, roeTTM: 12, debtToEquity: 0.2 }),
    candidate("STDY", { drift: 0.0008, wiggle: 0.003 }, { revenueGrowthTTM: 9, revenueGrowth3Y: 10, netMarginTTM: 22, roeTTM: 25, debtToEquity: 0.3 }),
    candidate("SLOW", { drift: -0.002, wiggle: 0.02 }, { revenueGrowthTTM: -10, revenueGrowth3Y: -4, netMarginTTM: -15, roeTTM: -8, debtToEquity: 2.5 }),
    candidate("NOFUND", { drift: 0.002, wiggle: 0.01 })
  ]);
  const by = Object.fromEntries(scored.map((item) => [item.symbol, item.scores]));
  assert.equal([...scored].sort((a, b) => b.scores.growth.score - a.scores.growth.score)[0].symbol, "GROW");
  assert.equal([...scored].sort((a, b) => b.scores.hold.score - a.scores.hold.score)[0].symbol, "STDY");
  assert.ok(by.SLOW.growth.score < by.STDY.growth.score && by.SLOW.hold.score < 20);
  assert.equal(by.NOFUND.growth.coverage < by.GROW.growth.coverage, true);
  assert.ok(by.NOFUND.growth.score !== null, "a stock without fundamentals is still scored on what was measured");
  assert.ok(by.GROW.growth.strengths.some((text) => /revenue growth 60%/.test(text)));
  assert.ok(by.SLOW.hold.concerns.length > 0);
});
