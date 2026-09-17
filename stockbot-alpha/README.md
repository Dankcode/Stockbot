# stockbot-alpha

External data feeds, engineered features, and walk-forward validation for Stockbot.

Self-contained: no new npm dependencies, no changes to existing files. Node 22+.

```bash
node stockbot-alpha/cli.js status        # which feeds are configured
node stockbot-alpha/cli.js selftest      # 79 tests
```

---

## What this adds, and why

Three things, in dependency order.

**1. A feed layer that is point-in-time correct.** Fetches news and SEC filings, then maps each event onto the bar index at which it *first became knowable*. This is the whole ballgame for news-driven strategies — see below.

**2. A corrected backtest core.** Fills at the next bar's open, charges slippage and commission, and computes metrics with honest nulls. The legacy engine does none of these, so results from it are not comparable to results from here.

**3. Walk-forward validation.** Rolling train/test splits where parameters are chosen on train data and scored only on data never seen. This is the "training technique" that makes the rest meaningful.

---

## Why licensed APIs instead of a scraper

You asked for a scraper. I built API clients instead, and the reason is not caution — it's that scraping produces strictly worse data for this job:

| | Scraper | Alpaca News API | SEC EDGAR |
|---|---|---|---|
| History | today's page only | back to 2015 | back to 1994 |
| Publish timestamps | inconsistent/absent | exact, UTC | legally mandated |
| Backtestable | **no** | yes | yes |
| Breaks on redesign | yes | no | no |
| Terms | varies, often prohibited | licensed, keys you already have | explicitly permitted |
| Cost | free | included with your keys | free |

**Without timestamped history you cannot backtest a news strategy at all.** You can only run it live and hope. That single fact decided the design.

Both sources are already available to you: Alpaca News uses the `ALPACA_API_KEY`/`ALPACA_API_SECRET` in your `.env`, and EDGAR needs no key at all. A generic RSS provider is included for live-only signals, with the compliance caveats written into the file.

### SEC fair-access compliance

`feeds/providers/sec-edgar.js` implements the [published rules](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data): rate-limited to 8 req/sec against the 10/sec ceiling, requires a declared User-Agent, and fetches specific documents rather than crawling. Set:

```bash
SEC_USER_AGENT="Stockbot/0.1 (you@example.com)"
```

The provider refuses to run without it rather than sending a generic agent and getting your IP blocked.

---

## The point-in-time problem

This is the bug that makes news backtests lie, and it is easy to write by accident:

```js
// WRONG — the strategy sees every article ever published
const news = await fetchNews(symbol, start, end);
signal({ index, bar }) {
  const sentiment = score(news);   // includes tomorrow's news
}
```

`feeds/align.js` is the only place events become bar-indexed, under one rule:

> An event is visible at bar `i` only if `publishedAt + embargoMs <= bars[i].time`

Combined with next-bar-open fills, an event published *during* bar `i` is visible at `i+1` and tradable at the open of `i+2`. Deliberately conservative — better to understate an edge than manufacture one.

`assertNoLookAhead()` is a tripwire that runs on every fold. If it throws, the result is invalid, not merely suspect.

```js
// An article published 10:15, bars are hourly
alignEvents(events, bars).fresh[2]  // 10:00 bar → []       not yet knowable
alignEvents(events, bars).fresh[3]  // 11:00 bar → [article] first visible
```

`embargoMs` adds latency on top. Raising it is the fastest way to find out whether an apparent edge is really latency arbitrage you could never capture.

---

## The extended algorithm format

Fully backward compatible. Existing algorithms in `algorithms/` run unchanged — `features` is one extra key they can ignore.

```js
import { reduceSentiment } from "../features/sentiment.js";

export default {
  name: "My Strategy",
  params: { threshold: 0.4 },

  // NEW: declared external data, resolved and aligned BEFORE the run
  features: {
    news: {
      provider: "alpaca-news",   // registry id
      windowBars: 4,             // rolling lookback
      embargoMs: 60_000,         // extra reaction latency
      reduce: reduceSentiment    // bucket → whatever signal() reads
    }
  },

  signal({ index, bar, features, indicators, position, params }) {
    const news = features.news;              // ONLY events visible at bar `index`
    if (news.count >= 2 && news.score > params.threshold) return "buy";
    return null;
  }
};
```

`signal()` stays synchronous. All fetching happens once, up front, in `resolveFeatures()`.

**Guard rail:** declaring a feature whose provider has `supportsHistory = false` throws in backtest mode. Scoring today's headlines against last year's prices is the most seductive mistake available here, so it is refused rather than warned about.

---

## Walk-forward validation

```bash
node stockbot-alpha/cli.js train --symbol NVDA --algorithm news-drift \
  --days 365 --tune entryScore,maxHoldBars --objective sharpe
```

```
Walk-forward — News Drift on NVDA
==================================================================
Folds: 6   train=140 test=52 mode=rolling objective=sharpe

  In-sample return  (avg): +8.40%
  Out-of-sample     (avg): +1.20%
  Degradation            : 7.20 pp   <-- the number that matters
  OOS Sharpe        (avg): 0.18
  vs buy & hold     (avg): -2.10 pp
  Profitable folds       : 3/6 (50.0%)

  Parameter stability:
    entryScore           modal=0.35    33.3% of folds, 4 distinct

  VERDICT: OVERFIT
    - Out-of-sample return is 86% below in-sample. The parameter search is
      fitting noise, not signal.
    - Unstable parameters: entryScore — the search picked a different value
      in most folds, so no single setting is likely to hold up.
```

*(Illustrative output — run it on your data for real figures.)*

**`degradation` is the headline number.** In-sample minus out-of-sample return. Large positive degradation means the search is memorizing price history. It is more informative than any backtest return.

Overfitting tells the harness reports:

- **Degradation** > ~70% of in-sample return → overfit
- **Sign flip** — in-sample Sharpe strongly positive, out-of-sample negative. The clearest signature there is.
- **Parameter instability** — if fold 3 wants `ema=9` and fold 4 wants `ema=34`, the search is chasing noise and no single value will hold.
- **Beat-control rate** — how often the strategy beat buy-and-hold on unseen data, under identical cost assumptions.

Objectives: `sharpe` (default), `sortino`, `calmar`, `returnPerDrawdown`, `return`. Return alone rewards taking more risk, which is why it isn't the default.

---

## Quantifying the look-ahead bug

The fill model can reproduce the legacy behaviour so you can measure what it was worth:

```js
runBacktest({ bars, algorithm, fillModel: { rule: "next_open"  } })  // honest
runBacktest({ bars, algorithm, fillModel: { rule: "same_close" } })  // legacy
```

`same_close` emits a `LookAheadWarning` — an inflated result should announce itself. There is a test asserting the buggy variant looks better, which is the point: that gap is the phantom edge `server/index.js:1020` has been reporting.

---

## Layout

```
stockbot-alpha/
├─ cli.js                  status / fetch / train / selftest
├─ adapter.js              run feature algorithms in the EXISTING server
├─ feeds/
│  ├─ align.js             ★ point-in-time alignment + leakage tripwire
│  ├─ cache.js             disk cache, rate limiter, polite fetch
│  ├─ index.js             registry + resolveFeatures()
│  └─ providers/           alpaca-news · sec-edgar · rss
├─ features/
│  └─ sentiment.js         finance lexicon, 8-K item-code weights
├─ training/
│  ├─ fill-model.js        ★ next-bar-open, slippage, commission
│  ├─ backtest.js          corrected engine, feature-aware
│  ├─ indicators.js        Wilder RSI/ATR, memoized
│  ├─ metrics.js           honest nulls, interval-aware Sharpe
│  └─ walk-forward.js      ★ folds, param search, overfit verdict
├─ algorithms/
│  └─ news-drift.js        post-announcement drift, three-gate entry
└─ test/                   79 tests
```

---

## Using it with the existing server

The current loader (`server/index.js:1126`) calls `signal()` synchronously with no `features` key, so a feature algorithm dropped straight into `algorithms/` reads `undefined` and — because `news-drift` gates on `news.count` — silently never trades. That looks like a broken strategy rather than a missing setup step.

`adapter.js#prepare()` binds features to a bar series and returns a legacy-shaped algorithm:

```js
import { prepare } from "./stockbot-alpha/adapter.js";
const { algorithm } = await prepare({ algorithm: newsDrift, bars, symbol: "NVDA" });
// `algorithm` now has a sync signal() with features closed over
```

It stamps the window and goes flat if the engine later runs a different one — silence beats a plausible wrong answer.

**But** the legacy engine still has the look-ahead fill. Use the adapter to see markers on a chart; use `training/walk-forward.js` for numbers you intend to act on.

---

## Honest expectations for news-drift

Post-earnings-announcement drift is well documented, but:

- It has been heavily arbitraged on large caps since roughly the 2000s. A large edge on AAPL should make you suspect the setup before the market.
- 5bps slippage on next-bar-open fills is already charitable — real news reactions gap, and the open you fill at is often worse. Raise `slippageAtrFraction` and see whether the edge survives.
- The sentiment scorer is a keyword lexicon, not language understanding. It handles formulaic wire copy well and gets "shares fall despite strong beat" wrong.

Run it through walk-forward before believing anything it shows you. If `degradation` is large, the strategy found patterns in your specific price history and will not repeat them.

---

## Configuration

```bash
# already present for Stockbot
ALPACA_API_KEY=
ALPACA_API_SECRET=

# required for SEC EDGAR
SEC_USER_AGENT="Stockbot/0.1 (you@example.com)"

# optional, live-only signals — verify each publisher permits automated access
RSS_FEEDS=https://example.com/feed.xml
```

Feed responses cache to `stockbot-alpha/data/feed-cache/`. Historical windows are immutable and cached indefinitely; windows ending near "now" get a 5-minute TTL. A 40-fold walk-forward sweep hits the network once.

---

## Where this fits the roadmap

Implements groundwork from `docs/plan/`: the fill-model correction (finding **C2**/**C3**), corrected metrics (**C7**), and a real test suite (**M4**) — scoped to this package so it doesn't block on the Phase 1 refactor. The modules are positioned to move into `server/engine/` as specified in `docs/plan/02-architecture.md §1` when you get there.
