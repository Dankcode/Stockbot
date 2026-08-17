// HORIZON PACK — Donchian Breakout @ monthly horizon (~21 bars held).
//
// One of twelve variants: three methods x four horizons, all reading the SAME 1day
// bars. "Monthly" is the target holding period, not a bar interval — the engine
// has no yearly interval, and weekly/monthly provider history is thin enough that
// resampling would change the experiment rather than the horizon.
//
// Monthly = position horizon; roughly one trading month per position.
//
// The turtle channel breakout, scaled by horizon. Breakout systems are conventionally slow; the daily variant here is deliberately included to test whether that convention actually holds on your symbols rather than assuming it.
//
// Congruent controls for this horizon (same bars, same window, same fill model):
//   control-horizon-fixed.js   params { horizon: "monthly" }
//   control-horizon-random.js  params { horizon: "monthly", seed: 1..20 }
//   control-buy-and-hold.js    horizon-independent upper bound on exposure
//
// Comparing this variant against a control tuned to a DIFFERENT horizon is not a
// comparison — turnover and exposure dominate the result. See docs/HORIZON_PACK.md.
export default {
  name: "Donchian Breakout — Monthly",
  author: "Stockbot horizon pack",
  description: "Donchian Breakout scaled to a ~21-bar holding period on daily bars.",
  params: {entryPeriod: 55, exitPeriod: 20, atrPeriod: 20, atrStopMultiple: 3},

  signal({ index, bar, params, indicators, position }) {
    if (index < params.entryPeriod) return null;
    const channelHigh = indicators.highestHigh(params.entryPeriod);
    const channelLow = indicators.lowestLow(params.exitPeriod);
    const atr = indicators.atr(params.atrPeriod);

    if (position.qty === 0) {
      return bar.close > channelHigh[index]
        ? { action: "buy", reason: `Close cleared the prior ${params.entryPeriod}-bar high` }
        : null;
    }

    if (bar.close < channelLow[index]) {
      return { action: "sell", reason: `Close broke the prior ${params.exitPeriod}-bar low` };
    }
    if (bar.close < position.entryPrice - atr[index] * params.atrStopMultiple) {
      return { action: "sell", reason: `${params.atrStopMultiple}x ATR(${params.atrPeriod}) stop` };
    }
    return null;
  }
};
