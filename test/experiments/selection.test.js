import assert from "node:assert/strict";
import test from "node:test";

import { RANGE_CONFIG } from "../../packages/shared/ranges.js";
import {
  DEFAULT_GATES,
  factsFromBars,
  rankCandidates,
  recommendSymbols,
  renderRecommendations,
  scoreCandidate
} from "../../server/experiments/selection.js";

function goodFacts(overrides = {}) {
  return {
    symbol: "GOOD",
    price: 120,
    barCount: 140,
    expectedBars: 140,
    medianDollarVolume: 800_000_000,
    atrPercent: 2.75,
    trendStrength: 0.25,
    researchDocumentCount: 10,
    researchSources: [{ id: "sec-edgar", retrievedAt: 1_700_000_000_000, snapshotId: "snap-1" }],
    ...overrides
  };
}

test("a liquid, moving, well-covered symbol scores near the top of the range", () => {
  const scored = scoreCandidate(goodFacts());
  assert.equal(scored.eligible, true);
  assert.ok(scored.score > 0.8, `expected > 0.8, got ${scored.score}`);
  assert.equal(scored.evidence.length, 1);
  assert.match(scored.reasons.join(" "), /liquidity/);
});

test("gates exclude rather than merely penalise", () => {
  const thin = scoreCandidate(goodFacts({ symbol: "THIN", medianDollarVolume: 500_000 }));
  assert.equal(thin.eligible, false);
  assert.match(thin.blockers.join(" "), /below the \$20M floor/);

  const penny = scoreCandidate(goodFacts({ symbol: "PENNY", price: 1.2 }));
  assert.equal(penny.eligible, false);
  assert.match(penny.blockers.join(" "), /below the 5 floor/);

  const short = scoreCandidate(goodFacts({ symbol: "NEW", barCount: 30 }));
  assert.equal(short.eligible, false);
  assert.match(short.blockers.join(" "), /only 30 bars of history/);
});

test("REGRESSION: the history gate is reachable at every range Stockbot supports", () => {
  // The gate was an absolute 250 bars. No range returns that many — the limits are
  // 60, 78, 180, 60, 140, 80, 140 — so every symbol was excluded at every range and
  // `run --auto` could never find a candidate. Assert against the real range table so
  // this can never silently drift out of reach again.
  const maxBars = Math.max(...Object.values(RANGE_CONFIG).map((range) => range.limit));
  assert.ok(
    DEFAULT_GATES.minBars <= maxBars,
    `minBars ${DEFAULT_GATES.minBars} exceeds the ${maxBars} bars any range can return`
  );
  for (const range of Object.values(RANGE_CONFIG)) {
    const full = scoreCandidate(goodFacts({ barCount: range.limit, expectedBars: range.limit }));
    assert.equal(full.eligible, true, `a full history at range ${range.key} must pass the gates`);
  }
});

test("history is gated on coverage of the requested window, not an absolute count", () => {
  const full = scoreCandidate(goodFacts({ barCount: 140, expectedBars: 140 }));
  const partial = scoreCandidate(goodFacts({ symbol: "NEWCO", barCount: 40, expectedBars: 140 }));
  assert.equal(full.eligible, true);
  assert.equal(partial.eligible, false);
  assert.match(partial.blockers.join(" "), /40 of 140 bars .*29% coverage/);
  // With no expectation supplied there is nothing to measure coverage against, so only
  // the absolute floor applies — a caller that cannot say what it asked for is not
  // punished for it.
  assert.equal(scoreCandidate(goodFacts({ barCount: 60, expectedBars: null })).eligible, true);
});

test("missing data shrinks the denominator instead of scoring as neutral", () => {
  const partial = scoreCandidate(goodFacts({ atrPercent: null, researchDocumentCount: null }));
  assert.deepEqual([...partial.unmeasured].sort(), ["researchCoverage", "volatility"]);
  assert.match(partial.reasons.join(" "), /not measured/);
  // Liquidity and trend are both strong. Dropping the unmeasured weights must leave the
  // score close to the full-data score, not drag it toward zero the way a 0-default
  // would: scoring the two absent components as 0 over the full denominator gives 0.41.
  const full = scoreCandidate(goodFacts()).score;
  assert.ok(partial.score > 0.7, `expected > 0.7, got ${partial.score}`);
  assert.ok(Math.abs(partial.score - full) < 0.1, `partial ${partial.score} should track full ${full}`);
  assert.ok(partial.score > 0.6, "a zero-default would have produced ~0.41");
});

test("volatility is a band, not a ramp — a dead symbol and a wild one both score low", () => {
  const dead = scoreCandidate(goodFacts({ atrPercent: 0.1 }));
  const wild = scoreCandidate(goodFacts({ atrPercent: 9 }));
  const workable = scoreCandidate(goodFacts({ atrPercent: 1.6 }));
  const ideal = scoreCandidate(goodFacts({ atrPercent: 2.75 }));
  assert.equal(dead.components.volatility, 0);
  assert.equal(wild.components.volatility, 0);
  assert.equal(ideal.components.volatility, 1);
  // The interesting property is the shape between the extremes, not just the ends: a
  // tradeable-but-quieter symbol must land strictly between dead and ideal.
  assert.ok(workable.components.volatility > 0.4 && workable.components.volatility < 1);
});

test("an unmeasured component is null, not zero — Number(null) must not sneak through", () => {
  const blank = scoreCandidate({ symbol: "X", price: 50, medianDollarVolume: 5e8, barCount: 400 });
  assert.equal(blank.components.volatility, null);
  assert.equal(blank.components.trendClarity, null);
  assert.equal(blank.components.researchCoverage, null);
  // A symbol with zero archived documents genuinely measured is a different fact.
  const zero = scoreCandidate({ symbol: "X", price: 50, medianDollarVolume: 5e8, barCount: 400, researchDocumentCount: 0 });
  assert.equal(zero.components.researchCoverage, 0);
});

test("ranking separates eligible from excluded and reports the leader's margin", () => {
  const ranked = rankCandidates([
    goodFacts({ symbol: "AAA" }),
    goodFacts({ symbol: "BBB", atrPercent: 1.0, trendStrength: 0.05, researchDocumentCount: 1 }),
    goodFacts({ symbol: "THIN", medianDollarVolume: 100_000 })
  ], { limit: 5 });

  assert.deepEqual(ranked.recommended.map((entry) => entry.symbol), ["AAA", "BBB"]);
  assert.equal(ranked.eligibleCount, 2);
  assert.deepEqual(ranked.excluded.map((entry) => entry.symbol), ["THIN"]);
  assert.ok(ranked.separation > 0);
});

test("separation is null with fewer than two eligible candidates", () => {
  assert.equal(rankCandidates([goodFacts()]).separation, null);
  assert.equal(rankCandidates([]).recommended.length, 0);
});

test("factsFromBars derives price, liquidity, volatility and trend from a bar series", () => {
  const bars = Array.from({ length: 300 }, (_, index) => {
    const close = 100 + index * 0.2;
    return { time: index * 86_400_000, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 5_000_000 };
  });
  const facts = factsFromBars({ symbol: "trend", bars, research: { documentCount: 4, sources: [{ id: "rss" }] } });
  assert.equal(facts.symbol, "TREND");
  assert.equal(facts.barCount, 300);
  assert.equal(facts.price, bars.at(-1).close);
  assert.ok(facts.medianDollarVolume > 700_000_000);
  assert.ok(facts.atrPercent > 0 && facts.atrPercent < 5);
  // Rising series ends above its 200-bar mean.
  assert.ok(facts.trendStrength > 0);
  assert.equal(facts.researchDocumentCount, 4);
});

test("recommendSymbols skips symbols whose bars fail and records why", async () => {
  const bars = Array.from({ length: 300 }, (_, index) => {
    const close = 100 + Math.sin(index / 9) * 12 + index * 0.15;
    return { time: index * 86_400_000, open: close, high: close + 2, low: close - 2, close, volume: 6_000_000 };
  });
  const result = await recommendSymbols({
    universe: ["aapl", "AAPL", "BROKE", "NVDA"],
    getBars: async (symbol) => {
      if (symbol === "BROKE") throw new Error("Real historical bars unavailable.");
      return { bars };
    },
    limit: 2
  });
  assert.equal(result.requested, 3, "duplicates are collapsed before fetching");
  assert.equal(result.scored, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].stage, "bars");
  assert.match(renderRecommendations(result), /not a prediction/);
});

test("a research adapter that throws degrades coverage instead of dropping the symbol", async () => {
  const bars = Array.from({ length: 300 }, (_, index) => ({
    time: index * 86_400_000, open: 100, high: 103, low: 98, close: 100 + index * 0.1, volume: 6_000_000
  }));
  const result = await recommendSymbols({
    universe: ["AAPL"],
    getBars: async () => ({ bars }),
    getResearch: async () => { throw new Error("RESEARCH_SOURCE_NOT_CONFIGURED"); }
  });
  assert.equal(result.scored, 1);
  assert.equal(result.errors[0].stage, "research");
  assert.ok(result.recommended[0].unmeasured.includes("researchCoverage"));
});

test("the default gates are the documented ones and are frozen", () => {
  assert.equal(DEFAULT_GATES.minMedianDollarVolume, 20_000_000);
  assert.equal(DEFAULT_GATES.minHistoryCoverage, 0.8);
  assert.ok(Object.isFrozen(DEFAULT_GATES));
});

test("recommendSymbols derives the expected bar count from the range it was given", async () => {
  const make = (count) => Array.from({ length: count }, (_, index) => ({
    time: index * 86_400_000, open: 100, high: 103, low: 98, close: 100 + index * 0.1, volume: 6_000_000
  }));
  const result = await recommendSymbols({
    universe: ["FULL", "SHORT"],
    range: "3M",
    getBars: async (symbol) => ({ bars: make(symbol === "FULL" ? 140 : 40) })
  });
  assert.deepEqual(result.recommended.map((entry) => entry.symbol), ["FULL"]);
  assert.deepEqual(result.excluded.map((entry) => entry.symbol), ["SHORT"]);
  assert.match(result.excluded[0].blockers.join(" "), /40 of 140 bars/);
});
