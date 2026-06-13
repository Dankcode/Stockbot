export type Candle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type AlgorithmTrade = {
  id: string;
  time: string;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  rule?: string;
  confidence?: number;
  pnlPercent: number;
  strategyName?: string;
  color?: string;
};

export type AlgorithmDiagnostic = {
  rsi: number;
  emaFast: number;
  emaSlow: number;
  vwap: number;
  atr: number;
  signalScore: number;
};

export type Asset = {
  symbol: string;
  name: string;
  sector: string;
  aliases?: string[];
  matchReason?: string;
  dataStatus?: "real" | "error" | "simulated";
  dataSource?: string;
  dataError?: string;
  quoteTime?: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  spark: number[];
  candles: Candle[];
  algorithmTrades: AlgorithmTrade[];
  diagnostics: AlgorithmDiagnostic;
  stats?: {
    marketCap: number;
    avgVolume: number;
    beta: number;
    peRatio: number | null;
  };
};

export type Position = {
  symbol: string;
  qty: number;
  avgPrice: number;
  price: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
};

export type PaperOrder = {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  filledAvgPrice: number;
  status: "filled";
  notional: number;
  submittedAt: string;
};

export type Portfolio = {
  cash: number;
  buyingPower: number;
  equity: number;
  dayChange: number;
  realizedPnl: number;
  positions: Position[];
  orders: PaperOrder[];
};

export type StrategyScore = {
  name: string;
  type: "primary" | "control";
  returnPercent: number;
  maxDrawdown: number;
  winRate: number;
  sharpe: number;
  profitFactor: number;
  trades: number;
  exposurePercent: number;
  avgTradePercent: number;
};
