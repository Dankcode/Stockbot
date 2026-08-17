// CONTROL — exposure-matched, information-free, and fully deterministic.
//
// Enters every `entryEveryBars` bars and holds for `holdBars`, ignoring price entirely.
// Where Control — Random Entry gives you a null *distribution*, this gives you a single
// reproducible null *path* with a known, tunable time-in-market.
//
// Its job is to separate two different claims that strategies routinely conflate:
//
//   1. "My rules pick good moments."      <- must beat this control
//   2. "Being in the market ~40% of the   <- this control already does that,
//       time on this symbol paid off."        with no rules at all
//
// Set holdBars / entryEveryBars so the control's reported `exposure` metric roughly
// matches your strategy's. An edge only counts if it survives that match.
export default {
  name: "Control — Fixed Interval",
  author: "Stockbot control group",
  description: "Exposure-matched control: buys every N bars and holds for M bars regardless of price. Tune N and M to match the strategy's exposure.",
  params: {
    entryEveryBars: 20,
    holdBars: 8,
    warmupBars: 1
  },

  init() {
    return { holdUntil: -1 };
  },

  signal({ index, params, state, position }) {
    const warmup = Number.isFinite(params.warmupBars) ? Math.max(1, Math.trunc(params.warmupBars)) : 1;
    if (index < warmup) return null;

    const cadence = Math.max(1, Math.trunc(params.entryEveryBars ?? 20));
    const hold = Math.max(1, Math.trunc(params.holdBars ?? 8));

    if (position.qty > 0) {
      if (index >= state.holdUntil) {
        return { action: "sell", reason: `Control exit after ${hold} bars held` };
      }
      return null;
    }

    if ((index - warmup) % cadence === 0) {
      state.holdUntil = index + hold;
      return { action: "buy", reason: `Control entry on fixed ${cadence}-bar cadence` };
    }
    return null;
  }
};
