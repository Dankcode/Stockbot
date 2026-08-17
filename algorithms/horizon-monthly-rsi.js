// HORIZON PACK — RSI Mean Reversion @ monthly horizon (~21 bars held).
//
// One of twelve variants: three methods x four horizons, all reading the SAME 1day
// bars. "Monthly" is the target holding period, not a bar interval — the engine
// has no yearly interval, and weekly/monthly provider history is thin enough that
// resampling would change the experiment rather than the horizon.
//
// Monthly = position horizon; roughly one trading month per position.
//
// Buys oversold recoveries and exits on reversion or a time stop. Mean reversion is strongest at short horizons and usually degrades badly as the holding period grows — this pack is designed to show you exactly where that happens.
//
// Note on the thresholds: RSI compresses toward 50 as its lookback grows, so the
// oversold trigger has to RISE with the horizon or the slow variants never fire at all.
// A literal RSI(50) < 30 reading is close to nonexistent — an earlier draft of this file
// used one and took zero trades across 1500 bars on every test series. The thresholds
// below were tuned until each horizon actually trades; they are not a fitted edge.
//
// Congruent controls for this horizon (same bars, same window, same fill model):
//   control-horizon-fixed.js   params { horizon: "monthly" }
//   control-horizon-random.js  params { horizon: "monthly", seed: 1..20 }
//   control-buy-and-hold.js    horizon-independent upper bound on exposure
//
// Comparing this variant against a control tuned to a DIFFERENT horizon is not a
// comparison — turnover and exposure dominate the result. See docs/HORIZON_PACK.md.
export default {
  name: "RSI Mean Reversion — Monthly",
  author: "Stockbot horizon pack",
  description: "RSI Mean Reversion scaled to a ~21-bar holding period on daily bars.",
  params: {period: 21, oversold: 40, exitLevel: 55, maxHoldBars: 21},

  signal({ index, bar, params, indicators, position }) {
    if (index <= params.period) return null;
    const rsi = indicators.rsi(params.period);

    if (position.qty === 0) {
      const recovering = rsi[index - 1] < params.oversold && rsi[index] >= params.oversold;
      return recovering
        ? { action: "buy", reason: `RSI(${params.period}) recovered up through ${params.oversold}` }
        : null;
    }

    if (rsi[index] >= params.exitLevel) {
      return { action: "sell", reason: `RSI(${params.period}) reverted to ${params.exitLevel}` };
    }
    if (index - position.entryIndex >= params.maxHoldBars) {
      return { action: "sell", reason: `Time stop after ${params.maxHoldBars} bars` };
    }
    return null;
  }
};
