export const DEFAULT_RISK_PROFILE = Object.freeze({
  id: "default",
  name: "Balanced paper guardrails",
  sizing: { mode: "risk_parity", perTradeRiskPercent: 1, fixedNotional: 1_000 },
  rules: {
    quoteFreshness: { enabled: true, maxAgeMs: 5_000 },
    marketHours: { enabled: true },
    priceSanity: { enabled: true, maxMovePercent: 10 },
    maxPositionSize: { enabled: true, percentOfEquity: 20 },
    maxPositionNotional: { enabled: false, amount: null },
    maxConcurrentPositions: { enabled: true, count: 5 },
    maxSymbolExposure: { enabled: true, percentOfEquity: 25 },
    minOrderNotional: { enabled: true, amount: 10 },
    maxOrdersPerMinute: { enabled: true, count: 10 },
    maxOrdersPerDay: { enabled: true, count: 100 },
    sufficientFunds: { enabled: true },
    maxDailyLoss: { enabled: true, percentOfStartingEquity: 3 },
    maxDrawdown: { enabled: true, percentFromPeak: 10 },
    maxAccountDrawdown: { enabled: true, percentFromPeak: 15 },
    positionStopLoss: { enabled: true, percent: 5 },
    positionTakeProfit: { enabled: false, percent: null },
    maxExposure: { enabled: true, warnPercent: 80, blockPercent: 100 },
    dataStaleness: { enabled: true, maxAgeMs: 60_000 }
  }
});

export function mergeRiskProfile(profile = {}) {
  return {
    ...DEFAULT_RISK_PROFILE,
    ...profile,
    sizing: { ...DEFAULT_RISK_PROFILE.sizing, ...(profile.sizing || {}) },
    rules: Object.fromEntries(Object.entries(DEFAULT_RISK_PROFILE.rules).map(([key, value]) => [key, { ...value, ...(profile.rules?.[key] || {}) }]))
  };
}
