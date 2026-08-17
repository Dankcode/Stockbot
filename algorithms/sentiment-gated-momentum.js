// SENTIMENT PACK — the treatment arm.
//
// An ordinary EMA momentum entry, gated on an archived research snapshot being
// available, bullish, and confident enough. Exits are NOT gated: once long, the
// position leaves on the technical rule or the stop, whether or not research is
// available. Gating exits on research would let a fetch failure trap capital in a
// losing trade, which is a data-availability bug dressed up as a strategy.
//
// Pin this to a session with `news-social-analysis` (or `social-sentiment`) and pair
// it with control-sentiment-blind.js, which runs the IDENTICAL technical rules with
// the research gate removed. That pairing is the entire experiment:
//
//   gated - blind = what the research is actually worth
//
// If the difference is not clearly positive across several symbols and seeds of the
// horizon controls, the research is decoration and you are paying an AI CLI to
// produce it.
//
// What the research frame can and cannot be:
//   available   -> summary.sentiment in {bullish, bearish, neutral, mixed}
//                  summary.confidence in [0, 1]
//   unavailable -> no eligible unexpired snapshot at this bar's decision time
//   null        -> the session pinned no plan at all
//
// The summary has no action, quantity, or price field by schema. This file is the
// only thing that converts context into a signal, and that signal still passes
// through normal risk and next-bar fill handling.
//
// Point-in-time safety is enforced by the engine, not here: a snapshot is visible
// only when availableAt <= bar.time and it has not expired. Backtests read archived
// snapshots only and never rerun a scraper to backfill history, so a plan imported
// today yields nothing for a window last year. That is correct, not a gap.
export default {
  name: "Sentiment-Gated Momentum",
  author: "Stockbot sentiment pack",
  description: "EMA(9/21) momentum entries permitted only when a point-in-time research snapshot is bullish at or above a confidence floor. Exits are ungated.",
  params: {
    fast: 9,
    slow: 21,
    stopLossPercent: 8,
    minConfidence: 0.6,
    allowMixed: 0
  },

  init() {
    return { gateOpen: 0, gateBlocked: 0, tradedOnSnapshot: null };
  },

  signal({ index, bar, params, state, indicators, position, research }) {
    if (index < params.slow) return null;

    const fast = indicators.ema(params.fast);
    const slow = indicators.ema(params.slow);

    // --- Exits first, and deliberately ungated. ---
    if (position.qty > 0) {
      if (bar.close <= position.entryPrice * (1 - params.stopLossPercent / 100)) {
        return { action: "sell", reason: `Protective stop at ${params.stopLossPercent}%` };
      }
      const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
      if (crossedDown) {
        return { action: "sell", reason: `EMA(${params.fast}) crossed below EMA(${params.slow})` };
      }
      return null;
    }

    // --- Entry: technical trigger must fire first. ---
    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const alreadyTrending = index === params.slow && fast[index] > slow[index];
    if (!crossedUp && !alreadyTrending) return null;

    // --- Then the research gate. ---
    if (!research || research.status !== "available") {
      state.gateBlocked += 1;
      return null;
    }

    const summary = research.snapshot.summary;
    const confidence = Number(summary.confidence);
    if (!Number.isFinite(confidence) || confidence < params.minConfidence) {
      state.gateBlocked += 1;
      return null;
    }

    const bullish = summary.sentiment === "bullish";
    const mixedAllowed = Number(params.allowMixed) === 1 && summary.sentiment === "mixed";
    if (!bullish && !mixedAllowed) {
      state.gateBlocked += 1;
      return null;
    }

    state.gateOpen += 1;
    state.tradedOnSnapshot = research.snapshot.id;
    return {
      action: "buy",
      reason: `EMA cross confirmed by ${summary.sentiment} research (confidence ${confidence.toFixed(2)}, snapshot ${research.snapshot.id})`,
      confidence
    };
  }
};
