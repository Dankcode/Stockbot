// Rotation momentum: the per-symbol holding rule that matches the Rotation page's
// screen. Hold a name while it is in a Stage 2 uptrend with positive 12-1 momentum;
// leave on a close below the 50-day mean or a 15% trailing stop from the highest close.
// Use it in a paper session on the symbols the Rotation page selects.
export default {
  name: "Rotation Momentum",
  author: "Stockbot",
  description: "Holds while close > 50-day > 200-day mean and 12-1 momentum is positive; exits below the 50-day mean or on a 15% trailing stop.",
  params: {
    fastPeriod: 50,
    slowPeriod: 200,
    momentumLookback: 231,
    momentumSkip: 21,
    maxRsi: 80,
    trailingStop: 0.15
  },

  init() {
    return { highestClose: null };
  },

  signal({ index, bar, closes, params, indicators, position, state }) {
    const history = Math.max(params.slowPeriod, params.momentumLookback + params.momentumSkip);
    if (index < history) return null;

    const fast = indicators.sma(params.fastPeriod)[index];
    const slow = indicators.sma(params.slowPeriod)[index];
    const rsi = indicators.rsi(14)[index];
    const base = closes[index - params.momentumSkip - params.momentumLookback];
    const recent = closes[index - params.momentumSkip];
    if (![fast, slow, rsi, base, recent].every(Number.isFinite) || base <= 0) return null;
    const momentum = recent / base - 1;
    const close = bar.close;

    if (position.qty > 0) {
      state.highestClose = Math.max(state.highestClose ?? close, close);
      if (close < fast) {
        state.highestClose = null;
        return { action: "sell", reason: `Close ${close.toFixed(2)} fell below the ${params.fastPeriod}-day mean ${fast.toFixed(2)}` };
      }
      if (close < state.highestClose * (1 - params.trailingStop)) {
        const high = state.highestClose;
        state.highestClose = null;
        return { action: "sell", reason: `Trailing stop: ${((1 - close / high) * 100).toFixed(1)}% below the highest close ${high.toFixed(2)}` };
      }
      return null;
    }

    if (close > fast && fast > slow && momentum > 0 && rsi <= params.maxRsi) {
      state.highestClose = close;
      return { action: "buy", reason: `Uptrend with 12-1 momentum ${(momentum * 100).toFixed(1)}% and RSI ${rsi.toFixed(0)}` };
    }
    return null;
  }
};
