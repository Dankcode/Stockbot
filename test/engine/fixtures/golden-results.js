const noTrades = Object.freeze({
  fills: [],
  metrics: {
    returnPercent: 0,
    finalEquity: 100000,
    tradeCount: 0,
    closedTradeCount: 0,
    winRate: null,
    maxDrawdown: 0,
    sharpe: 0,
    sortino: null,
    profitFactor: null,
    exposurePercent: 0,
    avgTradePercent: null,
    openPosition: false
  }
});

const emaMomentum = Object.freeze({
  fills: [
    { side: "buy", signalIndex: 21, fillIndex: 22, referencePrice: 100.35 },
    { side: "sell", signalIndex: 38, fillIndex: 39, referencePrice: 94.5725 }
  ],
  metrics: {
    returnPercent: -5.469482,
    finalEquity: 94530.518192,
    tradeCount: 2,
    closedTradeCount: 1,
    winRate: 0,
    maxDrawdown: 32.659148,
    sharpe: -0.442447,
    sortino: -0.622897,
    profitFactor: 0,
    exposurePercent: 37.777778,
    avgTradePercent: -5.757349,
    openPosition: false
  }
});

const donchianBreakout = Object.freeze({
  fills: [
    { side: "buy", signalIndex: 22, fillIndex: 23, referencePrice: 107.784 },
    { side: "sell", signalIndex: 35, fillIndex: 36, referencePrice: 117.4095 }
  ],
  metrics: {
    returnPercent: 8.483843,
    finalEquity: 108483.842681,
    tradeCount: 2,
    closedTradeCount: 1,
    winRate: 100,
    maxDrawdown: 17.488063,
    sharpe: 1.491324,
    sortino: 2.531779,
    profitFactor: null,
    exposurePercent: 28.888889,
    avgTradePercent: 8.930361,
    openPosition: false
  }
});

const rsiMeanReversion = Object.freeze({
  fills: [
    { side: "buy", signalIndex: 18, fillIndex: 19, referencePrice: 82.656 },
    { side: "sell", signalIndex: 21, fillIndex: 22, referencePrice: 100.35 }
  ],
  metrics: {
    returnPercent: 20.336455,
    finalEquity: 120336.454694,
    tradeCount: 2,
    closedTradeCount: 1,
    winRate: 100,
    maxDrawdown: 0,
    sharpe: 4.224246,
    sortino: null,
    profitFactor: null,
    exposurePercent: 6.666667,
    avgTradePercent: 21.406794,
    openPosition: false
  }
});

export const bundledAlgorithmGolden = Object.freeze({
  "control-buy-and-hold": {
    fills: [{ side: "buy", signalIndex: 1, fillIndex: 2, referencePrice: 97.804 }],
    metrics: {
      returnPercent: 19.616989,
      finalEquity: 119616.989061,
      tradeCount: 1,
      closedTradeCount: 0,
      winRate: null,
      maxDrawdown: 36.45014,
      sharpe: 1.816099,
      sortino: 3.086895,
      profitFactor: null,
      exposurePercent: 97.777778,
      avgTradePercent: null,
      openPosition: true
    }
  },
  "control-fixed-interval": {
    fills: [
      { side: "buy", signalIndex: 1, fillIndex: 2, referencePrice: 97.804 },
      { side: "sell", signalIndex: 9, fillIndex: 10, referencePrice: 82.451 },
      { side: "buy", signalIndex: 21, fillIndex: 22, referencePrice: 100.35 },
      { side: "sell", signalIndex: 29, fillIndex: 30, referencePrice: 142.714 },
      { side: "buy", signalIndex: 41, fillIndex: 42, referencePrice: 92 }
    ],
    metrics: {
      returnPercent: 51.217498,
      finalEquity: 151217.498082,
      tradeCount: 5,
      closedTradeCount: 2,
      winRate: 50,
      maxDrawdown: 15.350906,
      sharpe: 5.550382,
      sortino: 17.46174,
      profitFactor: 2.288269,
      exposurePercent: 44.444444,
      avgTradePercent: 13.25926,
      openPosition: true
    }
  },
  "control-horizon-fixed": {
    fills: [
      { side: "buy", signalIndex: 1, fillIndex: 2, referencePrice: 97.804 },
      { side: "sell", signalIndex: 6, fillIndex: 7, referencePrice: 88 },
      { side: "buy", signalIndex: 14, fillIndex: 15, referencePrice: 72.252 },
      { side: "sell", signalIndex: 19, fillIndex: 20, referencePrice: 86.739 },
      { side: "buy", signalIndex: 27, fillIndex: 28, referencePrice: 138 },
      { side: "sell", signalIndex: 32, fillIndex: 33, referencePrice: 136.08 },
      { side: "buy", signalIndex: 40, fillIndex: 41, referencePrice: 88.733 }
    ],
    metrics: {
      returnPercent: 39.591818,
      finalEquity: 139591.81829,
      tradeCount: 7,
      closedTradeCount: 3,
      winRate: 33.333333,
      maxDrawdown: 9.522923,
      sharpe: 5.074458,
      sortino: 14.585281,
      profitFactor: 1.574389,
      exposurePercent: 44.444444,
      avgTradePercent: 2.878407,
      openPosition: true
    }
  },
  "control-horizon-random": {
    fills: [
      { side: "buy", signalIndex: 2, fillIndex: 3, referencePrice: 96.528 },
      { side: "sell", signalIndex: 8, fillIndex: 9, referencePrice: 83.832 },
      { side: "buy", signalIndex: 17, fillIndex: 18, referencePrice: 77.649 },
      { side: "sell", signalIndex: 24, fillIndex: 25, referencePrice: 122.4465 },
      { side: "buy", signalIndex: 25, fillIndex: 26, referencePrice: 130.032 },
      { side: "sell", signalIndex: 31, fillIndex: 32, referencePrice: 138.3745 },
      { side: "buy", signalIndex: 34, fillIndex: 35, referencePrice: 124 },
      { side: "sell", signalIndex: 42, fillIndex: 43, referencePrice: 97.3395 },
      { side: "buy", signalIndex: 43, fillIndex: 44, referencePrice: 102.794 }
    ],
    metrics: {
      returnPercent: 30.437191,
      finalEquity: 130437.191415,
      tradeCount: 9,
      closedTradeCount: 4,
      winRate: 50,
      maxDrawdown: 29.073665,
      sharpe: 2.766063,
      sortino: 4.950677,
      profitFactor: 1.343254,
      exposurePercent: 64.444444,
      avgTradePercent: 7.363743,
      openPosition: true
    }
  },
  "control-random-entry": noTrades,
  "control-sentiment-blind": emaMomentum,
  "donchian-breakout": donchianBreakout,
  "ema-momentum": emaMomentum,
  "horizon-daily-donchian": {
    fills: [
      { side: "buy", signalIndex: 18, fillIndex: 19, referencePrice: 82.656 },
      { side: "sell", signalIndex: 32, fillIndex: 33, referencePrice: 136.08 },
      { side: "buy", signalIndex: 44, fillIndex: 45, referencePrice: 110.605 }
    ],
    metrics: {
      returnPercent: 71.654168,
      finalEquity: 171654.167975,
      tradeCount: 3,
      closedTradeCount: 1,
      winRate: 100,
      maxDrawdown: 5.429238,
      sharpe: 7.560583,
      sortino: 37.424158,
      profitFactor: null,
      exposurePercent: 33.333333,
      avgTradePercent: 64.634146,
      openPosition: true
    }
  },
  "horizon-daily-ema": {
    fills: [
      { side: "buy", signalIndex: 18, fillIndex: 19, referencePrice: 82.656 },
      { side: "sell", signalIndex: 34, fillIndex: 35, referencePrice: 124 },
      { side: "buy", signalIndex: 44, fillIndex: 45, referencePrice: 110.605 }
    ],
    metrics: {
      returnPercent: 56.888251,
      finalEquity: 156888.251255,
      tradeCount: 3,
      closedTradeCount: 1,
      winRate: 100,
      maxDrawdown: 12.894441,
      sharpe: 5.869635,
      sortino: 16.520114,
      profitFactor: null,
      exposurePercent: 37.777778,
      avgTradePercent: 50.019357,
      openPosition: true
    }
  },
  "horizon-daily-rsi": {
    fills: [
      { side: "buy", signalIndex: 16, fillIndex: 17, referencePrice: 75.4125 },
      { side: "sell", signalIndex: 17, fillIndex: 18, referencePrice: 77.649 },
      { side: "buy", signalIndex: 41, fillIndex: 42, referencePrice: 92 },
      { side: "sell", signalIndex: 43, fillIndex: 44, referencePrice: 102.794 }
    ],
    metrics: {
      returnPercent: 14.27741,
      finalEquity: 114277.409803,
      tradeCount: 4,
      closedTradeCount: 2,
      winRate: 100,
      maxDrawdown: 0.42821,
      sharpe: 3.88489,
      sortino: 69.11713,
      profitFactor: null,
      exposurePercent: 6.666667,
      avgTradePercent: 7.349149,
      openPosition: false
    }
  },
  "horizon-monthly-donchian": noTrades,
  "horizon-monthly-ema": noTrades,
  "horizon-monthly-rsi": {
    fills: [{ side: "buy", signalIndex: 42, fillIndex: 43, referencePrice: 97.3395 }],
    metrics: {
      returnPercent: 20.163937,
      finalEquity: 120163.936514,
      tradeCount: 1,
      closedTradeCount: 0,
      winRate: null,
      maxDrawdown: 0,
      sharpe: 4.175611,
      sortino: null,
      profitFactor: null,
      exposurePercent: 6.666667,
      avgTradePercent: null,
      openPosition: true
    }
  },
  "horizon-weekly-donchian": donchianBreakout,
  "horizon-weekly-ema": emaMomentum,
  "horizon-weekly-rsi": {
    fills: [
      { side: "buy", signalIndex: 17, fillIndex: 18, referencePrice: 77.649 },
      { side: "sell", signalIndex: 19, fillIndex: 20, referencePrice: 86.739 },
      { side: "buy", signalIndex: 42, fillIndex: 43, referencePrice: 97.3395 },
      { side: "sell", signalIndex: 44, fillIndex: 45, referencePrice: 110.605 }
    ],
    metrics: {
      returnPercent: 25.507696,
      finalEquity: 125507.695517,
      tradeCount: 4,
      closedTradeCount: 2,
      winRate: 100,
      maxDrawdown: 0.28654,
      sharpe: 4.936075,
      sortino: 192.995324,
      profitFactor: null,
      exposurePercent: 8.888889,
      avgTradePercent: 12.6673,
      openPosition: false
    }
  },
  "horizon-yearly-donchian": noTrades,
  "horizon-yearly-ema": noTrades,
  "horizon-yearly-rsi": noTrades,
  "rsi-mean-reversion": rsiMeanReversion,
  "sentiment-gated-momentum": noTrades,
  "trend-pullback": noTrades
});
