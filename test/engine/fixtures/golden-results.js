export const bundledAlgorithmGolden = Object.freeze({
  "donchian-breakout": {
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
  },
  "ema-momentum": {
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
  },
  "rsi-mean-reversion": {
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
  }
});
