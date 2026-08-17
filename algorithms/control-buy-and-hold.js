// CONTROL — passive exposure baseline.
//
// Buys the tested symbol at the first available fill and never sells. This is the
// control that answers the only question that matters first: did the strategy beat
// simply owning the thing it was trading?
//
// Stockbot already benchmarks every run against SPY buy-and-hold and Cash. Those are
// market-level controls. This one is the *same-asset* control, and it is usually the
// harder benchmark to beat, because it strips out the symbol's own drift from the
// strategy's reported return.
//
// Exposure is ~100% by construction, so compare it on risk-adjusted terms (Sharpe,
// Sortino, max drawdown) rather than on total return alone.
export default {
  name: "Control — Buy and Hold",
  author: "Stockbot control group",
  description: "Passive same-asset control: buys once on the first fillable bar and holds to the end of the window. Never sells.",
  params: { warmupBars: 1 },

  init() {
    return { entered: false };
  },

  signal({ index, params, state, position }) {
    const warmup = Number.isFinite(params.warmupBars) ? Math.max(1, Math.trunc(params.warmupBars)) : 1;
    if (index < warmup) return null;
    if (state.entered || position.qty > 0) return null;

    state.entered = true;
    return { action: "buy", reason: "Passive control entry: buy and hold to end of window" };
  }
};
