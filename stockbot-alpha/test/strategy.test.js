/**
 * Sentiment, walk-forward and end-to-end integration tests.
 *
 * The end-to-end test is the one that matters most: it wires a real algorithm
 * with declared features through the aligner and the backtest core using
 * synthetic events, and asserts the strategy could not have acted on news
 * before it was published.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { scoreHeadline, reduceSentiment, reduceFilings, LEXICON } from "../features/sentiment.js";
import { buildFolds, expandGrid, walkForward, OBJECTIVES, formatReport } from "../training/walk-forward.js";
import { runBacktest } from "../training/backtest.js";
import { alignEvents, assertNoLookAhead, rollingWindow } from "../feeds/align.js";
import { makeBars, makeRamp, makeEvents, HOUR } from "./fixtures.js";
import newsDrift from "../algorithms/news-drift.js";

const BASE = Date.UTC(2025, 0, 6, 14, 30);

// ─────────────────────────────────────────────────────────────────────────────
// Sentiment
// ─────────────────────────────────────────────────────────────────────────────

test("scoreHeadline separates clear positives from clear negatives", () => {
  const good = scoreHeadline("Acme beats estimates and raises guidance");
  const bad = scoreHeadline("Acme misses estimates and cuts guidance");

  assert.ok(good.score > 0.4, `expected strongly positive, got ${good.score}`);
  assert.ok(bad.score < -0.4, `expected strongly negative, got ${bad.score}`);
  assert.ok(good.magnitude > 0);
});

test("neutral text scores zero", () => {
  const result = scoreHeadline("Acme Corporation schedules its annual shareholder meeting");
  assert.equal(result.score, 0);
  assert.equal(result.hits.length, 0);
});

test("empty and non-string input is handled", () => {
  for (const input of ["", "   ", null, undefined, 42]) {
    const result = scoreHeadline(input);
    assert.equal(result.score, 0);
    assert.equal(result.magnitude, 0);
  }
});

test("scores are bounded to [-1, 1]", () => {
  const piled = scoreHeadline(
    "bankruptcy fraud delisting plunges crashes sec investigation accounting irregularities " +
      "profit warning slashes forecast suspends dividend going concern"
  );
  assert.ok(piled.score >= -1 && piled.score <= 1, `out of bounds: ${piled.score}`);
  assert.ok(piled.score < -0.5);
});

test("negation flips polarity", () => {
  const plain = scoreHeadline("Acme beats estimates");
  const negated = scoreHeadline("Acme does not beat estimates, fails to meet targets");

  assert.ok(plain.score > 0);
  assert.ok(negated.score < 0, `negated phrasing should be negative, got ${negated.score}`);
});

test("phrases are not double-counted with their component words", () => {
  const phrase = scoreHeadline("Acme beats estimates");
  // "beats estimates" (0.85) should win over a second count of bare "beats" (0.6).
  const terms = phrase.hits.map((h) => h.term);
  assert.ok(terms.includes("beats estimates"));
  assert.ok(!terms.includes("beats"), "bare 'beats' must be consumed by the phrase match");
});

test("finance-specific neutrals do not register as negative", () => {
  // A general-purpose lexicon scores these negative and is wrong to.
  const result = scoreHeadline("Acme reports capital costs, tax liability and debt levels");
  assert.equal(result.score, 0, `finance neutrals leaked a score: ${JSON.stringify(result.hits)}`);
  assert.equal(LEXICON.liability, 0);
  assert.equal(LEXICON.tax, 0);
});

test("magnitude distinguishes mixed news from no news", () => {
  const silent = scoreHeadline("Acme names new regional office manager");
  const mixed = scoreHeadline("Acme beats estimates but cuts guidance");

  assert.equal(silent.magnitude, 0);
  assert.ok(mixed.magnitude > 0.5, "mixed news should be high-magnitude even at low polarity");
  assert.ok(Math.abs(mixed.score) < Math.abs(scoreHeadline("Acme beats estimates").score));
});

test("reduceSentiment weights single-ticker articles above baskets", () => {
  const focused = reduceSentiment(
    [{ headline: "Acme raises guidance", symbols: ["TEST"] }],
    { symbol: "TEST" }
  );
  const basket = reduceSentiment(
    [{ headline: "Acme raises guidance", symbols: Array.from({ length: 16 }, (_, i) => `S${i}`).concat("TEST") }],
    { symbol: "TEST" }
  );

  assert.ok(focused.score > 0);
  // Same headline, but spread across 17 tickers — magnitude should be diluted.
  assert.ok(basket.magnitude < focused.magnitude, "broad tagging must dilute the signal");
});

test("reduceSentiment discounts articles that omit the symbol", () => {
  const onTopic = reduceSentiment([{ headline: "raises guidance", symbols: ["TEST"] }], { symbol: "TEST" });
  const offTopic = reduceSentiment([{ headline: "raises guidance", symbols: ["OTHER"] }], { symbol: "TEST" });

  assert.ok(onTopic.magnitude > offTopic.magnitude);
});

test("reduceSentiment handles an empty bucket", () => {
  const result = reduceSentiment([]);
  assert.deepEqual(result, { count: 0, score: 0, magnitude: 0, maxAbs: 0, topHeadline: null });
});

test("reduceFilings reads 8-K item codes, not headline text", () => {
  const bankruptcy = reduceFilings([
    { headline: "Material event", meta: { form: "8-K", items: "1.03,2.04" } }
  ]);
  const activist = reduceFilings([{ headline: "stake", meta: { form: "SC 13D" } }]);

  assert.ok(bankruptcy.score < -0.5, "item 1.03 is bankruptcy — must score strongly negative");
  assert.equal(bankruptcy.materialEvents, 1);
  assert.ok(activist.score > 0);
  assert.deepEqual(activist.forms, ["SC 13D"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Walk-forward mechanics
// ─────────────────────────────────────────────────────────────────────────────

test("buildFolds produces non-overlapping test windows", () => {
  const folds = buildFolds(300, { trainBars: 100, testBars: 20 });

  assert.ok(folds.length > 5);
  for (let i = 1; i < folds.length; i += 1) {
    assert.ok(folds[i].test[0] >= folds[i - 1].test[1], "test windows must not overlap");
  }
  for (const fold of folds) {
    assert.ok(fold.test[0] >= fold.train[1], "test must start at or after train ends");
  }
});

test("anchored mode keeps train start at zero", () => {
  const folds = buildFolds(300, { trainBars: 100, testBars: 20, mode: "anchored" });
  for (const fold of folds) assert.equal(fold.train[0], 0);
  assert.ok(folds.at(-1).train[1] > folds[0].train[1], "anchored train window must grow");
});

test("embargoBars inserts a gap between train and test", () => {
  const folds = buildFolds(300, { trainBars: 100, testBars: 20, embargoBars: 5 });
  for (const fold of folds) {
    assert.equal(fold.test[0] - fold.train[1], 5);
  }
});

test("buildFolds refuses an impossible configuration", () => {
  assert.throws(() => buildFolds(50, { trainBars: 100, testBars: 20 }), /not enough for trainBars/);
  assert.throws(() => buildFolds(300, { trainBars: 5, testBars: 20 }), /trainBars must be an integer >= 10/);
});

test("expandGrid produces the full cartesian product", () => {
  const combos = expandGrid({ a: [1, 2], b: ["x", "y", "z"] });
  assert.equal(combos.length, 6);
  assert.deepEqual(combos[0], { a: 1, b: "x" });
  assert.equal(new Set(combos.map((c) => JSON.stringify(c))).size, 6);

  assert.deepEqual(expandGrid({}), [{}]);
  assert.deepEqual(expandGrid(undefined), [{}]);
  assert.throws(() => expandGrid({ a: [] }), /non-empty array/);
});

test("objectives rank by the intended quantity", () => {
  const strong = { sharpe: 1.8, returnPercent: 20, maxDrawdown: 10, calmar: 2, sortino: 2.2 };
  const weak = { sharpe: 0.2, returnPercent: 25, maxDrawdown: 40, calmar: 0.6, sortino: 0.3 };

  assert.ok(OBJECTIVES.sharpe(strong) > OBJECTIVES.sharpe(weak));
  // Return alone prefers the riskier strategy — which is why it is not the default.
  assert.ok(OBJECTIVES.return(weak) > OBJECTIVES.return(strong));
  assert.ok(OBJECTIVES.returnPerDrawdown(strong) > OBJECTIVES.returnPerDrawdown(weak));
  // A null Sharpe must never win a comparison.
  assert.equal(OBJECTIVES.sharpe({ sharpe: null }), -Infinity);
});

test("walkForward selects params on train and scores on unseen test data", async () => {
  const bars = makeBars({ count: 400, driftPerBar: 0.0004, volatility: 0.012, seed: 21 });

  // Simple MA crossover with a tunable fast period.
  const algo = {
    name: "ma-cross",
    params: { fast: 10, slow: 40 },
    signal: ({ index, params, indicators, position }) => {
      const fast = indicators.sma(params.fast);
      const slow = indicators.sma(params.slow);
      if (fast[index] == null || slow[index] == null || fast[index - 1] == null) return null;
      const up = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
      const down = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
      if (position.qty === 0 && up) return "buy";
      if (position.qty > 0 && down) return "sell";
      return null;
    }
  };

  const result = await walkForward({
    bars,
    algorithm: algo,
    symbol: "TEST",
    features: {},
    grid: { fast: [5, 10, 20] },
    trainBars: 150,
    testBars: 50,
    objective: "sharpe",
    minTradesPerFold: 1
  });

  assert.ok(result.summary, "expected a summary");
  assert.ok(result.summary.foldCount >= 2, `only ${result.summary.foldCount} folds scored`);

  for (const fold of result.folds.filter((f) => !f.skipped)) {
    assert.ok([5, 10, 20].includes(fold.chosenParams.fast));
    assert.ok(fold.inSample, "in-sample metrics recorded");
    assert.ok(fold.outOfSample, "out-of-sample metrics recorded");
    assert.ok(fold.control, "control run on the same test window");
    // The searched table should show every grid point was evaluated on train.
    assert.equal(fold.searched.length, 3);
  }

  assert.ok(typeof result.verdict.overfit === "boolean");
  assert.ok(Array.isArray(result.verdict.notes) && result.verdict.notes.length > 0);
  assert.ok(result.summary.paramStability.fast, "parameter stability reported");
  assert.ok(result.summary.stitchedOutOfSample, "stitched OOS curve computed");
});

test("walkForward reports degradation when the search overfits", async () => {
  // Pure noise: any parameter that looks good on train is fitting randomness,
  // so out-of-sample should be meaningfully worse than in-sample.
  const bars = makeBars({ count: 500, driftPerBar: 0, volatility: 0.02, seed: 99 });

  const noisy = {
    name: "noise-fitter",
    params: { threshold: 50 },
    signal: ({ index, params, indicators, position }) => {
      const rsi = indicators.rsi(14);
      if (rsi[index] == null) return null;
      if (position.qty === 0 && rsi[index] < params.threshold) return "buy";
      if (position.qty > 0 && rsi[index] > params.threshold + 10) return "sell";
      return null;
    }
  };

  const result = await walkForward({
    bars,
    algorithm: noisy,
    symbol: "TEST",
    features: {},
    // A deliberately over-fine grid — 9 knobs on pure noise.
    grid: { threshold: [30, 35, 40, 45, 50, 55, 60, 65, 70] },
    trainBars: 200,
    testBars: 40,
    objective: "sharpe"
  });

  assert.ok(result.summary.degradation != null, "degradation must be computed");
  // The verdict should say something substantive rather than a bare pass.
  assert.ok(result.verdict.notes.length > 0);
  const report = formatReport(result);
  assert.match(report, /Degradation/);
  assert.match(report, /VERDICT/);
});

test("walkForward skips folds where nothing trades", async () => {
  const bars = makeBars({ count: 300, seed: 4 });
  const never = { name: "never", params: {}, signal: () => null };

  const result = await walkForward({
    bars, algorithm: never, symbol: "TEST", features: {},
    trainBars: 100, testBars: 40, minTradesPerFold: 1
  });

  assert.equal(result.summary, null);
  assert.ok(result.folds.every((f) => f.skipped));
  assert.match(result.verdict.note, /did not trade enough/);
});

test("minTradesPerFold rejects parameter sets that barely trade", async () => {
  const bars = makeBars({ count: 300, seed: 8 });
  const rare = {
    name: "rare",
    params: { threshold: 5 },
    signal: ({ index, params, indicators, position }) => {
      const rsi = indicators.rsi(14);
      if (rsi[index] == null) return null;
      // A threshold of 5 almost never triggers.
      if (position.qty === 0 && rsi[index] < params.threshold) return "buy";
      if (position.qty > 0) return "sell";
      return null;
    }
  };

  const result = await walkForward({
    bars, algorithm: rare, symbol: "TEST", features: {},
    grid: { threshold: [2, 5] }, trainBars: 120, testBars: 40, minTradesPerFold: 5
  });

  const searched = result.folds.flatMap((f) => f.searched ?? []);
  assert.ok(searched.some((s) => s.eligible === false), "under-trading params must be marked ineligible");
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: features → aligner → backtest
// ─────────────────────────────────────────────────────────────────────────────

test("end-to-end: news features reach the strategy, point-in-time correct", () => {
  const bars = makeRamp({ count: 120, startPrice: 100, step: 0.4 });

  // Positive news clustered around bar 60.
  const events = makeEvents(
    [
      { offsetMs: 58 * HOUR + 10 * 60_000, headline: "Acme beats estimates and raises guidance" },
      { offsetMs: 58 * HOUR + 40 * 60_000, headline: "Analysts upgrade Acme, price target raised" },
      { offsetMs: 59 * HOUR + 5 * 60_000, headline: "Acme announces buyback, record revenue" }
    ],
    BASE
  );

  const embargoMs = 60_000;
  const { fresh } = alignEvents(events, bars, { embargoMs });
  assertNoLookAhead(fresh, bars, { embargoMs });

  const windowed = rollingWindow(fresh, newsDrift.features.news.windowBars);
  assertNoLookAhead(windowed, bars, { embargoMs });

  const newsFeature = windowed.map((bucket, index) =>
    reduceSentiment(bucket, { index, symbol: "TEST" })
  );

  // Record what the strategy saw, and when.
  const observed = [];
  const instrumented = {
    ...newsDrift,
    signal(ctx) {
      if (ctx.features.news?.count > 0) {
        observed.push({ index: ctx.index, count: ctx.features.news.count, score: ctx.features.news.score });
      }
      return newsDrift.signal.call(this, ctx);
    }
  };

  const result = runBacktest({
    bars,
    algorithm: instrumented,
    features: { news: newsFeature },
    startingCash: 100_000,
    fillModel: { slippageBps: 5 }
  });

  assert.ok(observed.length > 0, "the strategy should have seen the news cluster");

  // Nothing before bar 59 may have seen any of it: the earliest event is at
  // 58h10m, plus a 60s embargo, so it is first visible at the bar opening at 59h.
  const earliest = Math.min(...observed.map((o) => o.index));
  assert.ok(earliest >= 59, `news visible too early — first seen at bar ${earliest}, expected >= 59`);

  // And the entry, if any, must fill strictly after the bar that saw the news.
  const buy = result.trades.find((t) => t.side === "buy");
  if (buy) {
    assert.ok(buy.index > buy.signalIndex, "fill must be after the signal bar");
    assert.ok(buy.signalIndex >= 59, `entry signalled at bar ${buy.signalIndex}, before the news was public`);
  }

  assert.ok(result.metrics, "metrics computed");
  assert.equal(result.metrics.tradeCount, result.trades.length);
});

test("news-drift declares its feature contract correctly", () => {
  assert.equal(typeof newsDrift.signal, "function");
  assert.ok(newsDrift.features?.news, "must declare a news feature");
  assert.equal(newsDrift.features.news.provider, "alpaca-news");
  assert.ok(newsDrift.features.news.windowBars >= 1);
  // A non-zero embargo is the honest default for a news strategy.
  assert.ok(newsDrift.features.news.embargoMs > 0, "should model reaction latency");
  assert.equal(typeof newsDrift.features.news.reduce, "function");
});

test("news-drift stays flat with no news and warms up safely", () => {
  const bars = makeRamp({ count: 120, startPrice: 100, step: 0.4 });
  const empty = bars.map(() => ({ count: 0, score: 0, magnitude: 0, maxAbs: 0, topHeadline: null }));

  const result = runBacktest({ bars, algorithm: newsDrift, features: { news: empty } });

  assert.equal(result.trades.length, 0, "no news means no trades");
  assert.equal(result.metrics.winRate, null);
  assert.equal(result.metrics.returnPercent, 0);
});

test("news-drift respects the volatility gate", () => {
  // Wild bars: ATR/price should exceed maxVolatilityPercent and block entry
  // even with strongly positive news.
  const bars = makeBars({ count: 150, volatility: 0.08, seed: 13 });
  const hot = bars.map(() => reduceSentiment([{ headline: "beats estimates and raises guidance", symbols: ["TEST"] }], { symbol: "TEST" }));
  // minArticles is 2, so duplicate the item to clear that gate specifically.
  const hotEnough = bars.map(() =>
    reduceSentiment(
      [
        { headline: "beats estimates and raises guidance", symbols: ["TEST"] },
        { headline: "upgraded to buy, price target raised", symbols: ["TEST"] }
      ],
      { symbol: "TEST" }
    )
  );

  const strict = runBacktest({
    bars, algorithm: newsDrift, features: { news: hotEnough },
    params: { maxVolatilityPercent: 0.01 }
  });
  const loose = runBacktest({
    bars, algorithm: newsDrift, features: { news: hotEnough },
    params: { maxVolatilityPercent: 100 }
  });

  assert.equal(strict.trades.length, 0, "an impossible volatility gate must block every entry");
  assert.ok(loose.trades.length > 0, "a permissive gate should allow entries");
  assert.ok(hot[0].score > 0);
});
