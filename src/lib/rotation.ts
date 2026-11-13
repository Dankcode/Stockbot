import { api } from "./api";

export type RotationRow = {
  symbol: string;
  sector: string;
  rank: number;
  score: number | null;
  price: number | null;
  bars: number;
  mom12_1: number | null;
  mom6m: number | null;
  mom3m: number | null;
  mom1m: number | null;
  vol20: number | null;
  sma50: number | null;
  sma200: number | null;
  trend: boolean | null;
  fromHigh: number | null;
  rsi14: number | null;
  adv20: number | null;
  eligible: boolean;
  blockers: string[];
  note?: string;
  selected: boolean;
  weight: number;
  spark: number[];
};

export type RotationRegime = {
  benchmark: string;
  close: number | null;
  sma: number | null;
  window: number;
  riskOn: boolean | null;
  distance: number | null;
};

export type RotationConfig = {
  topN: number;
  minPrice: number;
  minDollarVolume: number;
  maxRsi: number;
  requireTrend: boolean;
  regimeSma: number;
  maxWeight: number;
  maxPerSector: number;
  weighting: "inverse_vol" | "equal";
  benchmark: string;
  weights: Record<string, number>;
};

type Unavailable = { available: false; reason: string; errors: { symbol: string; message: string }[]; requested: number };

export type RotationScreen = Unavailable | {
  available: true;
  asOf: number;
  sources: string[];
  requested: number;
  scored: number;
  eligibleCount: number;
  errors: { symbol: string; message: string }[];
  survivorshipWarning: string;
  regime: RotationRegime;
  regimeSeries: { time: number; close: number; sma: number | null }[];
  config: RotationConfig;
  selected: string[];
  targets: Record<string, number>;
  cashWeight: number;
  rows: RotationRow[];
  caption: string;
};

export type RotationMetrics = {
  returnPercent: number;
  finalEquity: number;
  tradeCount: number;
  closedTradeCount: number;
  winRate: number | null;
  maxDrawdown: number;
  sharpe: number | null;
  sortino: number | null;
  profitFactor: number | null;
  exposurePercent: number;
  avgTradePercent: number | null;
};

export type RotationTrade = {
  time: number;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  notional: number;
  reason: string;
  realizedPnl: number | null;
  pnlPercent: number | null;
};

export type RotationBacktest = Unavailable | {
  available: true;
  start: number;
  end: number;
  sources: string[];
  scored: number;
  requested: number;
  errors: { symbol: string; message: string }[];
  survivorshipWarning: string;
  settings: { startingEquity: number; rebalanceEvery: number; trailingStop: number; rebalanceBand: number; fillModel: { slippageBps: number } };
  metrics: Record<string, RotationMetrics>;
  equityCurve: { time: number; equity: number }[];
  benchmarkCurve: { time: number; equity: number }[];
  drawdown: { time: number; value: number }[];
  trades: RotationTrade[];
  rebalances: { time: number; riskOn: boolean | null; selected: string[]; stopped?: string[] }[];
  unfilledRebalance: { time: number } | null;
};

export type RotationInputs = {
  top: number;
  weighting: "inverse_vol" | "equal";
  years: number;
  rebalance: number;
  stop: number;
};

function query(inputs: RotationInputs, keys: (keyof RotationInputs)[]) {
  return keys.map((key) => `${key}=${encodeURIComponent(String(inputs[key]))}`).join("&");
}

export function fetchRotation(inputs: RotationInputs) {
  return api.get<RotationScreen>(`/rotation?${query(inputs, ["top", "weighting"])}`);
}

export function fetchRotationBacktest(inputs: RotationInputs) {
  return api.get<RotationBacktest>(`/rotation/backtest?${query(inputs, ["top", "weighting", "years", "rebalance", "stop"])}`);
}
