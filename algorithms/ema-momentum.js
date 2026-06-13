// Trend-following momentum: ride the trend while the fast EMA is above the slow EMA.
// One of the most widely used systematic methods (MA crossover with a protective stop).
export default {
  name: "EMA Momentum Cross",
  author: "Stockbot",
  description: "Buys when EMA(9) crosses above EMA(21); exits on the cross-down or an 8% protective stop.",
  params: { fast: 9, slow: 21, stopLossPercent: 8 },

  signal({ index, bar, params, indicators, position }) {
    if (index < params.slow) {
      return null;
    }
    const fast = indicators.ema(params.fast);
    const slow = indicators.ema(params.slow);

    // Protective stop loss while in a position.
    if (position.qty > 0 && bar.close <= position.entryPrice * (1 - params.stopLossPercent / 100)) {
      return "sell";
    }

    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const alreadyTrending = index === params.slow && fast[index] > slow[index];
    if (position.qty === 0 && (crossedUp || alreadyTrending)) {
      return "buy";
    }

    const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
    if (position.qty > 0 && crossedDown) {
      return "sell";
    }
    return null;
  }
};
