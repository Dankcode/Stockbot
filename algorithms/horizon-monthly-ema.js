// HORIZON PACK — EMA Momentum @ monthly horizon (~21 bars held).
//
// One of twelve variants: three methods x four horizons, all reading the SAME 1day
// bars. "Monthly" is the target holding period, not a bar interval — the engine
// has no yearly interval, and weekly/monthly provider history is thin enough that
// resampling would change the experiment rather than the horizon.
//
// Monthly = position horizon; roughly one trading month per position.
//
// Trend-following moving-average crossover with a protective stop. Faster horizons cross more often and pay more slippage; slower horizons cross rarely and sit through deeper drawdowns.
//
// Congruent controls for this horizon (same bars, same window, same fill model):
//   control-horizon-fixed.js   params { horizon: "monthly" }
//   control-horizon-random.js  params { horizon: "monthly", seed: 1..20 }
//   control-buy-and-hold.js    horizon-independent upper bound on exposure
//
// Comparing this variant against a control tuned to a DIFFERENT horizon is not a
// comparison — turnover and exposure dominate the result. See docs/HORIZON_PACK.md.
export default {
  name: "EMA Momentum — Monthly",
  author: "Stockbot horizon pack",
  description: "EMA Momentum scaled to a ~21-bar holding period on daily bars.",
  params: {fast: 21, slow: 55, stopLossPercent: 15},

  signal({ index, bar, params, indicators, position }) {
    if (index < params.slow) return null;
    const fast = indicators.ema(params.fast);
    const slow = indicators.ema(params.slow);

    if (position.qty > 0 && bar.close <= position.entryPrice * (1 - params.stopLossPercent / 100)) {
      return { action: "sell", reason: `Protective stop at ${params.stopLossPercent}%` };
    }

    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const alreadyTrending = index === params.slow && fast[index] > slow[index];
    if (position.qty === 0 && (crossedUp || alreadyTrending)) {
      return { action: "buy", reason: `EMA(${params.fast}) crossed above EMA(${params.slow})` };
    }

    const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
    if (position.qty > 0 && crossedDown) {
      return { action: "sell", reason: `EMA(${params.fast}) crossed below EMA(${params.slow})` };
    }
    return null;
  }
};
