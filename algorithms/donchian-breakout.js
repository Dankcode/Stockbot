// Channel breakout: the "turtle trader" method. Buy strength when price clears the
// recent range high; exit on a break of the recent low or a volatility (ATR) stop.
export default {
  name: "Donchian Breakout (Turtle)",
  author: "Stockbot",
  description: "Buys a close above the prior 20-bar high; exits below the prior 10-bar low or a 2x ATR(14) stop.",
  params: { entryPeriod: 20, exitPeriod: 10, atrPeriod: 14, atrStopMultiple: 2 },

  signal({ index, bar, params, indicators, position }) {
    if (index < params.entryPeriod) {
      return null;
    }
    const channelHigh = indicators.highestHigh(params.entryPeriod);
    const channelLow = indicators.lowestLow(params.exitPeriod);
    const atr = indicators.atr(params.atrPeriod);

    if (position.qty === 0) {
      return bar.close > channelHigh[index] ? "buy" : null;
    }

    const brokeChannel = bar.close < channelLow[index];
    const atrStop = bar.close < position.entryPrice - atr[index] * params.atrStopMultiple;
    return brokeChannel || atrStop ? "sell" : null;
  }
};
