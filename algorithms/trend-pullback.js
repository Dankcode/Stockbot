// Trend pullback: participate only in an established uptrend after momentum recovers
// from a short pullback. The ATR trail gives the exit a volatility-scaled distance.
export default {
  name: "Trend Pullback with ATR Trail",
  author: "Stockbot",
  description: "Buys an RSI recovery above a rising EMA trend; exits on trend failure, momentum loss, ATR trail, or a time stop.",
  params: {
    fastPeriod: 20,
    slowPeriod: 50,
    rsiPeriod: 14,
    entryRsi: 55,
    exitRsi: 45,
    atrPeriod: 14,
    atrTrailMultiple: 3,
    maxHoldBars: 40
  },

  init() {
    return { highestClose: null };
  },

  signal({ index, bar, params, indicators, position, state }) {
    const minimumHistory = Math.max(params.slowPeriod, params.rsiPeriod, params.atrPeriod);
    if (index < minimumHistory) return null;

    const fast = indicators.ema(params.fastPeriod);
    const slow = indicators.ema(params.slowPeriod);
    const rsi = indicators.rsi(params.rsiPeriod);
    const atr = indicators.atr(params.atrPeriod);
    const values = [fast[index], slow[index], rsi[index], rsi[index - 1], atr[index]];
    if (!values.every(Number.isFinite)) return null;

    if (position.qty === 0) {
      state.highestClose = null;
      const trendIsUp = fast[index] > slow[index] && slow[index] > slow[index - 1];
      const momentumRecovered = rsi[index - 1] < params.entryRsi && rsi[index] >= params.entryRsi;
      if (trendIsUp && momentumRecovered) {
        return {
          action: "buy",
          reason: "Uptrend confirmed and RSI recovered from pullback",
          confidence: Math.min(1, (fast[index] - slow[index]) / atr[index] / 4 + 0.5)
        };
      }
      return null;
    }

    state.highestClose = Math.max(Number(state.highestClose ?? bar.close), bar.close);
    const trendFailed = fast[index] < slow[index];
    const momentumFailed = rsi[index] <= params.exitRsi;
    const atrTrail = bar.close <= state.highestClose - atr[index] * params.atrTrailMultiple;
    const timeStop = index - position.entryIndex >= params.maxHoldBars;
    if (trendFailed || momentumFailed || atrTrail || timeStop) {
      return {
        action: "sell",
        reason: trendFailed ? "Fast EMA fell below slow EMA" :
          momentumFailed ? "RSI lost recovery momentum" :
            atrTrail ? "ATR trailing stop" : "Maximum holding period reached"
      };
    }
    return null;
  }
};
