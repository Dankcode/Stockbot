// Mean reversion: buy short-term oversold dips, exit when price reverts to normal.
// Classic RSI(14) reversion with a time-based bail-out so capital is never stuck.
export default {
  name: "RSI Mean Reversion",
  author: "Stockbot",
  description: "Buys when RSI(14) recovers up through 30 (oversold bounce); exits when RSI reaches 55 or after 20 bars.",
  params: { period: 14, oversold: 30, exitLevel: 55, maxHoldBars: 20 },

  signal({ index, params, indicators, position }) {
    if (index <= params.period) {
      return null;
    }
    const rsi = indicators.rsi(params.period);

    if (position.qty === 0) {
      const recoveringFromOversold = rsi[index - 1] < params.oversold && rsi[index] >= params.oversold;
      return recoveringFromOversold ? "buy" : null;
    }

    const reverted = rsi[index] >= params.exitLevel;
    const heldTooLong = index - position.entryIndex >= params.maxHoldBars;
    return reverted || heldTooLong ? "sell" : null;
  }
};
