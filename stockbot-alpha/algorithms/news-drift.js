/**
 * News Drift — trades post-announcement drift, gated on trend and volatility.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE IDEA
 * ─────────────────────────────────────────────────────────────────────────────
 * Post-earnings-announcement drift is one of the most durable documented
 * anomalies: prices continue moving in the direction of a surprise for days
 * afterward, apparently because information diffuses slowly. This strategy is a
 * cheap approximation — it does not know the surprise, only that the wire is
 * unusually positive about a name.
 *
 * Entry requires three things to agree, deliberately:
 *   1. Sentiment above threshold, on more than one article (a single headline is
 *      noise, and one mis-scored word shouldn't open a position)
 *   2. Price above its slow moving average — do not fight the trend
 *   3. Volatility not extreme — after a huge move the drift is usually spent,
 *      and slippage eats what remains
 *
 * Exit is whichever comes first: sentiment reversal, a time stop, an ATR stop,
 * or a take-profit. The time stop matters most: drift decays, and a position
 * held past its half-life is just directionless market exposure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONEST EXPECTATIONS
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this through walk-forward before believing anything it shows you. Two
 * specific reasons to be skeptical of a good result:
 *
 *   • Drift on large caps has been heavily arbitraged since roughly the 2000s.
 *     If this shows a large edge on AAPL, suspect the setup before the market.
 *   • With slippage at 5bps and next-bar-open fills you are already being
 *     charitable — a real news reaction gaps, and the open you fill at is often
 *     worse than the model assumes. Raise slippageAtrFraction and see whether
 *     the edge survives.
 *
 * Requires ALPACA_API_KEY / ALPACA_API_SECRET (news feed).
 */

import { reduceSentiment } from "../features/sentiment.js";

export default {
  name: "News Drift",
  author: "Stockbot Alpha",
  description:
    "Enters on clustered positive news when price is above trend and volatility is normal. " +
    "Exits on sentiment reversal, time stop, ATR stop, or take-profit.",

  params: {
    /** Minimum weighted sentiment to consider entering. */
    entryScore: 0.35,
    /** Minimum articles in the window — one headline is noise. */
    minArticles: 2,
    /** Sentiment at or below this exits a long. */
    exitScore: -0.15,
    /** Slow MA period for the trend gate. */
    trendPeriod: 50,
    /** Bars to hold before the time stop fires. Drift decays; do not overstay. */
    maxHoldBars: 10,
    /** Stop loss in ATR multiples. */
    atrStopMultiple: 2.0,
    /** Take profit in ATR multiples. */
    atrTargetMultiple: 3.5,
    /** Skip entries when ATR/price exceeds this — the move already happened. */
    maxVolatilityPercent: 6.0
  },

  /**
   * Declared external data. Resolved once before the run by
   * feeds/index.js#resolveFeatures, aligned point-in-time, then exposed at
   * `context.features.news`.
   */
  features: {
    news: {
      provider: "alpaca-news",
      /**
       * Look back four bars. Drift responds to a *cluster* of coverage, and a
       * one-bar window would miss a story that broke mid-bar.
       */
      windowBars: 4,
      /**
       * 60s embargo on top of the next-bar-open fill. Models the gap between a
       * wire crossing and an automated reader acting on it. Raising this is the
       * fastest way to test whether an apparent edge is really just latency
       * arbitrage you could never capture.
       */
      embargoMs: 60_000,
      reduce: reduceSentiment
    }
  },

  init() {
    return { entryAtr: null, entryBar: null };
  },

  signal({ index, bar, params, indicators, features, position, state }) {
    const news = features.news ?? { count: 0, score: 0 };

    const atr = indicators.atr(14)[index];
    const trend = indicators.sma(params.trendPeriod)[index];

    // Warmup: nulls mean insufficient history. Trading through it would fire on
    // an undefined comparison.
    if (atr == null || trend == null) return null;

    const volatilityPercent = (atr / bar.close) * 100;

    // ─── Exits, checked first: risk management outranks opportunity ───────
    if (position.qty > 0) {
      const entryAtr = state.entryAtr ?? atr;

      if (bar.close <= position.entryPrice - entryAtr * params.atrStopMultiple) return "sell";
      if (bar.close >= position.entryPrice + entryAtr * params.atrTargetMultiple) return "sell";
      if (position.barsHeld >= params.maxHoldBars) return "sell";
      if (news.count > 0 && news.score <= params.exitScore) return "sell";

      return null;
    }

    // ─── Entry: all three gates must agree ───────────────────────────────
    if (news.count < params.minArticles) return null;
    if (news.score < params.entryScore) return null;
    if (bar.close <= trend) return null;
    if (volatilityPercent > params.maxVolatilityPercent) return null;

    // Stash ATR at entry so the stop is anchored to conditions at the decision,
    // not to a later ATR that has already widened because the trade went wrong.
    state.entryAtr = atr;
    state.entryBar = index;
    return "buy";
  }
};
