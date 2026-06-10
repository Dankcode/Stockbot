import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  BarChart3,
  Eye,
  GripVertical,
  Maximize2,
  LineChart,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Table2,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { compareBaselines } from "./control/baselines";
import { evaluateStockbotMomentum } from "./strategy/stockbotStrategy";
import type { AlgorithmTrade, Asset, Candle, Portfolio, StrategyScore } from "./types";
import "./styles.css";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const defaultTabs = ["PLTR", "NVDA", "TSLA", "AAPL", "SPY"];
const methodMetrics = [
  { key: "returnPercent", label: "Return", format: (strategy: StrategyScore) => `${strategy.returnPercent >= 0 ? "+" : ""}${strategy.returnPercent}%` },
  { key: "winRate", label: "Win", format: (strategy: StrategyScore) => `${strategy.winRate}%` },
  { key: "maxDrawdown", label: "Drawdown", format: (strategy: StrategyScore) => `${strategy.maxDrawdown}%` },
  { key: "sharpe", label: "Sharpe", format: (strategy: StrategyScore) => strategy.sharpe.toFixed(2) },
  { key: "profitFactor", label: "Profit", format: (strategy: StrategyScore) => strategy.profitFactor.toFixed(2) },
  { key: "trades", label: "Trades", format: (strategy: StrategyScore) => number.format(strategy.trades) },
  { key: "exposurePercent", label: "Exposure", format: (strategy: StrategyScore) => `${strategy.exposurePercent}%` },
  { key: "avgTradePercent", label: "Avg Trade", format: (strategy: StrategyScore) => `${strategy.avgTradePercent >= 0 ? "+" : ""}${strategy.avgTradePercent}%` }
] as const;

type MethodMetricKey = (typeof methodMetrics)[number]["key"];
type ChartOverlay = "trades" | "ma" | "vwap" | "bands" | "wicks";
type ChartRange = "1H" | "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";
type AnalysisTab = "trace" | "calculations";
type PanelId = "chart" | "analysis" | "multiCharts" | "portfolio" | "signal" | "methods";
type SavedCandle = {
  id: string;
  symbol: string;
  strategyName: string;
  range: ChartRange;
  time: string;
  candleIndex: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bodyPercent: number;
  rangePercent: number;
};
type SettingField = {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  value: string;
  hasValue: boolean;
  maskedValue?: string;
};
type SettingGroup = {
  id: string;
  label: string;
  fields: SettingField[];
};
type SettingsPayload = {
  envFilePresent: boolean;
  groups: SettingGroup[];
};
type BacktestResult = {
  symbol: string;
  range: ChartRange;
  source: string;
  bars: Candle[];
  trades: AlgorithmTrade[];
  equityCurve: Array<{ time: string; equity: number; cash: number; positionValue: number }>;
  metrics: {
    startingCash: number;
    finalEquity: number;
    returnPercent: number;
    tradeCount: number;
    openPosition: boolean;
  } | null;
};
type CacheEntry<T> = {
  at: number;
  data: T;
};

const panelLabels: Record<PanelId, string> = {
  chart: "Chart",
  analysis: "Analysis",
  multiCharts: "Tabs",
  portfolio: "Portfolio",
  signal: "Signal",
  methods: "Methods"
};
const defaultPanelOrder: PanelId[] = ["chart", "analysis", "multiCharts", "portfolio", "signal", "methods"];
const cacheTtl = {
  market: 1800,
  portfolio: 5000,
  strategies: 60000,
  search: 15000,
  backtest: 120000,
  settings: 30000
};

const chartRanges: Array<{ key: ChartRange; label: string; points: number; days: number; resolution: string }> = [
  { key: "1H", label: "1H", points: 12, days: 0, resolution: "5 min" },
  { key: "1D", label: "1D", points: 79, days: 1, resolution: "5 min" },
  { key: "1W", label: "1W", points: 65, days: 7, resolution: "45 min" },
  { key: "1M", label: "1M", points: 72, days: 30, resolution: "4 hr" },
  { key: "3M", label: "3M", points: 90, days: 90, resolution: "1 day" },
  { key: "1Y", label: "1Y", points: 96, days: 365, resolution: "4 day" },
  { key: "ALL", label: "ALL", points: 110, days: 1460, resolution: "2 week" }
];

function priceMoney(value: number, reference = value) {
  const decimals = priceDecimals(reference);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(value);
}

function mergeAssets(primary: Asset[], extras: Asset[]) {
  const merged = new Map<string, Asset>();
  for (const asset of primary) {
    merged.set(asset.symbol, asset);
  }
  for (const asset of extras) {
    if (!merged.has(asset.symbol)) {
      merged.set(asset.symbol, asset);
    }
  }
  return Array.from(merged.values());
}

function hasRealMarketData(asset: Asset | null | undefined) {
  return Boolean(asset) && asset?.dataStatus !== "error";
}

function assetPriceLabel(asset: Asset) {
  return hasRealMarketData(asset) ? priceMoney(asset.price) : "Load error";
}

function panelSpan(panelId: PanelId) {
  return panelId === "chart" || panelId === "analysis" || panelId === "multiCharts" || panelId === "methods" ? "wide" : "narrow";
}

function candleY(value: number, min: number, span: number, top: number, height: number) {
  return top + height - ((value - min) / span) * height;
}

function priceDecimals(reference: number) {
  const value = Math.abs(Number(reference));
  if (value < 1) {
    return 4;
  }
  if (value < 10) {
    return 3;
  }
  return 2;
}

function roundPrice(value: number, reference = value) {
  return Number(Number(value).toFixed(priceDecimals(reference)));
}

function normalizeCandle(candle: Candle, referencePrice: number): Candle {
  const open = roundPrice(candle.open, referencePrice);
  const close = roundPrice(candle.close, referencePrice);
  const high = roundPrice(Math.max(candle.high, open, close), referencePrice);
  const low = roundPrice(Math.min(candle.low, open, close), referencePrice);

  return {
    ...candle,
    open,
    high,
    low,
    close,
    volume: Math.max(0, Math.round(candle.volume))
  };
}

function symbolSeed(symbol: string) {
  return Array.from(symbol).reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

function movingAverage(candles: Candle[], windowSize = 8) {
  return candles.map((_, index) => {
    const sample = candles.slice(Math.max(0, index - windowSize + 1), index + 1);
    return sample.reduce((sum, candle) => sum + candle.close, 0) / sample.length;
  });
}

function formatRangeTime(range: ChartRange, index: number, points: number, days: number) {
  const now = new Date();
  const date = new Date(now);
  const offsetDays = days * (1 - index / Math.max(points - 1, 1));
  date.setDate(now.getDate() - offsetDays);

  if (range === "1W") {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }
  if (range === "1M" || range === "3M") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (range === "1Y") {
    return date.toLocaleDateString("en-US", { month: "short" });
  }
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function clampPercent(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildRangeCandles(asset: Asset, range: ChartRange) {
  const config = chartRanges.find((item) => item.key === range) ?? chartRanges[1];
  if (range === "1H") {
    return asset.candles.slice(-config.points).map((candle) => normalizeCandle(candle, asset.price));
  }
  if (range === "1D") {
    return asset.candles.map((candle) => normalizeCandle(candle, asset.price));
  }

  const seed = symbolSeed(asset.symbol);
  const totalMove = clampPercent(asset.changePercent / 100 + (((seed % 31) - 14) / 100) * Math.log10(config.days + 3), -0.42, 0.68);
  const startClose = asset.price / (1 + totalMove);
  const volatility = Math.max(0.003, Math.min(0.045, Math.abs(asset.changePercent) / 950 + config.days / 90000));
  const candles: Candle[] = [];
  let lastClose = startClose;

  for (let point = 0; point < config.points; point += 1) {
    const progress = point / Math.max(config.points - 1, 1);
    const trend = startClose + (asset.price - startClose) * progress;
    const wave = Math.sin(progress * Math.PI * 6 + seed * 0.07) * volatility;
    const cycle = Math.cos(point * 0.73 + seed * 0.11) * volatility * 0.54;
    const close = point === config.points - 1 ? asset.price : roundPrice(trend * (1 + wave + cycle), asset.price);
    const open = lastClose;
    const spread = Math.max(Math.abs(close) * (volatility * 0.85 + 0.0012), 0.0001);
    const high = Math.max(open, close) + spread;
    const low = Math.min(open, close) - spread;
    candles.push(normalizeCandle({
      time: formatRangeTime(range, point, config.points, config.days),
      open,
      high,
      low,
      close,
      volume: Math.round((asset.volume / config.points) * (0.72 + Math.abs(wave + cycle) * 28 + progress * 0.34))
    }, asset.price));
    lastClose = close;
  }

  return candles;
}

function getVisibleCandles(asset: Asset, range: ChartRange, zoom: number, overrideCandles?: Candle[]) {
  const candles = overrideCandles?.length ? overrideCandles.map((candle) => normalizeCandle(candle, asset.price)) : buildRangeCandles(asset, range);
  return candles.slice(-Math.min(zoom, candles.length));
}

function strategySeed(value: string) {
  return Array.from(value).reduce((sum, character, index) => sum + character.charCodeAt(0) * (index + 3), 0);
}

function buildStrategyTrades(asset: Asset, strategyName: string) {
  if (strategyName === "Stockbot Momentum") {
    return [];
  }
  if (strategyName === "Cash") {
    return [];
  }

  const candles = asset.candles.map((candle) => normalizeCandle(candle, asset.price));
  const seed = strategySeed(`${asset.symbol}-${strategyName}`);
  const profiles: Record<string, Array<{ at: number; side: "buy" | "sell"; rule: string }>> = {
    "Mean Reversion": [
      { at: 0.2, side: "buy", rule: "RSI deviation below lower band" },
      { at: 0.44, side: "sell", rule: "Price reverted to VWAP mean" },
      { at: 0.58, side: "buy", rule: "Second pullback held support" },
      { at: 0.78, side: "sell", rule: "Mean target reached" }
    ],
    "Breakout Reversal": [
      { at: 0.28, side: "buy", rule: "Breakout candle cleared resistance" },
      { at: 0.39, side: "sell", rule: "Failed continuation reversed signal" },
      { at: 0.66, side: "buy", rule: "Retest reclaimed breakout level" },
      { at: 0.88, side: "sell", rule: "ATR extension exit" }
    ],
    "Buy and Hold SPY": [{ at: 0.08, side: "buy", rule: "Benchmark entry held through window" }],
    "Equal Weight Movers": [
      { at: 0.18, side: "buy", rule: "Entered volatility basket" },
      { at: 0.52, side: "sell", rule: "Rebalanced equal-weight basket" },
      { at: 0.74, side: "buy", rule: "Re-entered top mover basket" }
    ],
    "RSI 30/70 Control": [
      { at: 0.16, side: "buy", rule: "RSI crossed up through 30" },
      { at: 0.47, side: "sell", rule: "RSI tagged upper control band" },
      { at: 0.72, side: "buy", rule: "RSI reset below lower control band" }
    ]
  };
  const profile = profiles[strategyName] ?? profiles["Mean Reversion"];
  let entryPrice: number | null = null;

  return profile.map((point, tradeIndex) => {
    const offset = ((seed + tradeIndex * 7) % 9) - 4;
    const candleIndex = Math.min(candles.length - 1, Math.max(0, Math.round(point.at * (candles.length - 1)) + offset));
    const candle = candles[candleIndex];
    const price = point.side === "buy" ? candle.close : candle.open;
    const pnlPercent = point.side === "sell" && entryPrice ? ((price - entryPrice) / entryPrice) * 100 : 0;
    if (point.side === "buy") {
      entryPrice = price;
    }

    return {
      id: `${asset.symbol}-${strategyName.replace(/[^a-z0-9]/gi, "-")}-${tradeIndex + 1}`,
      time: candle.time,
      side: point.side,
      price: roundPrice(price, asset.price),
      quantity: 4 + ((seed + tradeIndex) % 5) * 2,
      rule: point.rule,
      confidence: Number((52 + Math.abs(Math.sin(seed + tradeIndex)) * 36).toFixed(1)),
      pnlPercent: Number(pnlPercent.toFixed(2))
    };
  });
}

function rangeStats(asset: Asset, range: ChartRange, zoom: number, overrideCandles?: Candle[]) {
  const candles = getVisibleCandles(asset, range, zoom, overrideCandles);
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const volume = candles.reduce((sum, candle) => sum + candle.volume, 0);
  const change = last.close - first.open;
  const changePercent = (change / first.open) * 100;

  return { first, last, high, low, volume, change, changePercent };
}

function candleBodyPercent(candle: Candle) {
  return ((candle.close - candle.open) / candle.open) * 100;
}

function candleRangePercent(candle: Candle) {
  return ((candle.high - candle.low) / candle.open) * 100;
}

function candleWickPercent(candle: Candle) {
  const body = Math.abs(candle.close - candle.open);
  return ((candle.high - candle.low - body) / candle.open) * 100;
}

function buildSavedCandle(asset: Asset, strategyName: string, range: ChartRange, candle: Candle, candleIndex: number): SavedCandle {
  return {
    id: `${asset.symbol}-${strategyName}-${range}-${candle.time}-${candleIndex}-${Date.now()}`,
    symbol: asset.symbol,
    strategyName,
    range,
    time: candle.time,
    candleIndex,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    bodyPercent: Number(candleBodyPercent(candle).toFixed(3)),
    rangePercent: Number(candleRangePercent(candle).toFixed(3))
  };
}

function calculationRows(asset: Asset, range: ChartRange, zoom: number, trades: AlgorithmTrade[], overrideCandles?: Candle[]) {
  const candles = getVisibleCandles(asset, range, zoom, overrideCandles);
  const averages = movingAverage(candles);
  let vwapNumerator = 0;
  let vwapDenominator = 0;

  return candles.map((candle, index) => {
    vwapNumerator += candle.close * candle.volume;
    vwapDenominator += candle.volume;
    const matchingTrade = trades.find((trade) => trade.time === candle.time);
    return {
      candle,
      index,
      ma8: averages[index],
      vwap: vwapNumerator / Math.max(vwapDenominator, 1),
      bodyPercent: candleBodyPercent(candle),
      rangePercent: candleRangePercent(candle),
      wickPercent: candleWickPercent(candle),
      trade: matchingTrade ? matchingTrade.side.toUpperCase() : ""
    };
  });
}

function getTradePoints(trades: AlgorithmTrade[], candles: Candle[], range: ChartRange) {
  if (range === "1H" || range === "1D") {
    return trades
      .map((trade) => {
        const candleIndex = candles.findIndex((candle) => candle.time === trade.time);
        return candleIndex >= 0 ? { trade, candleIndex, price: trade.price } : null;
      })
      .filter(Boolean) as Array<{ trade: AlgorithmTrade; candleIndex: number; price: number }>;
  }

  return trades.map((trade, index) => {
    const position = 0.18 + index * (0.68 / Math.max(trades.length - 1, 1));
    const candleIndex = Math.min(candles.length - 1, Math.max(0, Math.round(position * (candles.length - 1))));
    return { trade, candleIndex, price: candles[candleIndex]?.close ?? trade.price };
  });
}

function CandlestickChart({
  asset,
  zoom,
  overlays,
  range,
  trades = [],
  historicalCandles,
  onSaveCandle,
  expanded = false
}: {
  asset: Asset;
  zoom: number;
  overlays: Record<ChartOverlay, boolean>;
  range: ChartRange;
  trades: AlgorithmTrade[];
  historicalCandles?: Candle[];
  onSaveCandle?: (candle: Candle, candleIndex: number) => void;
  expanded?: boolean;
}) {
  const [hoveredCandle, setHoveredCandle] = React.useState<{ candle: Candle; index: number; x: number; y: number } | null>(null);
  const candles = getVisibleCandles(asset, range, zoom, historicalCandles);
  const visibleTrades = getTradePoints(trades, candles, range);
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const span = high - low || 1;
  const chart = expanded ? { left: 62, right: 44, top: 20, bottom: 64, width: 994, height: 430 } : { left: 54, right: 40, top: 22, bottom: 58, width: 786, height: 250 };
  const viewBox = expanded ? "0 0 1100 560" : "0 0 880 360";
  const volumeBase = expanded ? 520 : 326;
  const axisY = expanded ? 546 : 346;
  const step = chart.width / candles.length;
  const bodyWidth = Math.max(3, Math.min(10, step * 0.55));
  const lastClose = candles[candles.length - 1]?.close ?? asset.price;
  const lastCloseY = candleY(lastClose, low, span, chart.top, chart.height);
  const averages = movingAverage(candles);
  const chartVwap = candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0) / Math.max(candles.reduce((sum, candle) => sum + candle.volume, 0), 1);
  const chartAtr = candles.slice(-14).reduce((sum, candle) => sum + (candle.high - candle.low), 0) / Math.max(candles.slice(-14).length, 1);
  const vwapY = candleY(chartVwap, low, span, chart.top, chart.height);
  const upperBandY = candleY(chartVwap + chartAtr * 1.5, low, span, chart.top, chart.height);
  const lowerBandY = candleY(chartVwap - chartAtr * 1.5, low, span, chart.top, chart.height);
  const averagePath = averages
    .map((average, index) => {
      const x = chart.left + index * step + step / 2;
      const y = candleY(average, low, span, chart.top, chart.height);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className={`candle-chart ${expanded ? "expanded" : ""}`} viewBox={viewBox} preserveAspectRatio="xMidYMin meet" role="img" aria-label={`${asset.symbol} ${range} candlestick chart`}>
      <rect className="plot-bg" x={chart.left} y={chart.top} width={chart.width} height={chart.height + 48} rx="3" />
      {[0, 1, 2, 3, 4].map((line) => {
        const y = chart.top + (chart.height / 4) * line;
        const labelValue = high - (span / 4) * line;
        return (
          <g key={line}>
            <line className="grid-line" x1={chart.left} x2={chart.left + chart.width} y1={y} y2={y} />
            <text className="axis-label" x={chart.left - 10} y={y + 4} textAnchor="end">
              {priceMoney(labelValue, asset.price)}
            </text>
          </g>
        );
      })}

      {candles.map((candle, index) => {
        const x = chart.left + index * step + step / 2;
        const open = candleY(candle.open, low, span, chart.top, chart.height);
        const close = candleY(candle.close, low, span, chart.top, chart.height);
        const highY = candleY(candle.high, low, span, chart.top, chart.height);
        const lowY = candleY(candle.low, low, span, chart.top, chart.height);
        const positive = candle.close >= candle.open;
        const bodyTop = Math.min(open, close);
        const bodyHeight = Math.max(1.5, Math.abs(open - close));
        const volumeHeight = Math.max(3, Math.min(expanded ? 48 : 38, (candle.volume / asset.volume) * (range === "1H" || range === "1D" ? 1200 : 4200)));

        return (
          <g key={`${candle.time}-${index}`} className={positive ? "candle-up" : "candle-down"}>
            {overlays.wicks && <line className="wick" x1={x} x2={x} y1={highY} y2={lowY} />}
            <rect className="candle-body" x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} rx="1" />
            <rect className="volume-bar" x={x - bodyWidth / 2} y={volumeBase - volumeHeight} width={bodyWidth} height={volumeHeight} rx="1" />
            <rect
              aria-label={`${asset.symbol} candle ${candle.time}`}
              className="candle-hitbox"
              height={chart.height + 48}
              onClick={() => onSaveCandle?.(candle, index)}
              onMouseEnter={() => setHoveredCandle({ candle, index, x, y: bodyTop })}
              onMouseLeave={() => setHoveredCandle(null)}
              role="button"
              tabIndex={0}
              width={Math.max(step, bodyWidth + 8)}
              x={x - Math.max(step, bodyWidth + 8) / 2}
              y={chart.top}
            />
          </g>
        );
      })}

      {overlays.bands && (
        <>
          <line className="band-line" x1={chart.left} x2={chart.left + chart.width} y1={upperBandY} y2={upperBandY} />
          <line className="band-line" x1={chart.left} x2={chart.left + chart.width} y1={lowerBandY} y2={lowerBandY} />
        </>
      )}
      {overlays.vwap && <line className="vwap-line" x1={chart.left} x2={chart.left + chart.width} y1={vwapY} y2={vwapY} />}
      {overlays.ma && <path className="average-line" d={averagePath} />}
      <line className="current-price-line" x1={chart.left} x2={chart.left + chart.width} y1={lastCloseY} y2={lastCloseY} />
      {hoveredCandle && (
        <g className="candle-hover">
          <line x1={hoveredCandle.x} x2={hoveredCandle.x} y1={chart.top} y2={chart.top + chart.height + 48} />
          <circle cx={hoveredCandle.x} cy={candleY(hoveredCandle.candle.close, low, span, chart.top, chart.height)} r="4" />
          <g transform={`translate(${Math.min(Math.max(hoveredCandle.x + 12, chart.left + 8), chart.left + chart.width - 176)} ${Math.max(hoveredCandle.y - 94, chart.top + 8)})`}>
            <rect width="168" height="104" rx="4" />
            <text x="8" y="17">Date / Time: {hoveredCandle.candle.time}</text>
            <text x="8" y="34">O {priceMoney(hoveredCandle.candle.open, asset.price)}</text>
            <text x="84" y="34">H {priceMoney(hoveredCandle.candle.high, asset.price)}</text>
            <text x="8" y="51">L {priceMoney(hoveredCandle.candle.low, asset.price)}</text>
            <text x="84" y="51">C {priceMoney(hoveredCandle.candle.close, asset.price)}</text>
            <text x="8" y="68">Vol {number.format(hoveredCandle.candle.volume)}</text>
            <text x="8" y="85">Body {candleBodyPercent(hoveredCandle.candle).toFixed(2)}%</text>
            <text x="84" y="85">Range {candleRangePercent(hoveredCandle.candle).toFixed(2)}%</text>
          </g>
        </g>
      )}
      {overlays.trades &&
        visibleTrades.map(({ trade, candleIndex, price }) => {
          const x = chart.left + candleIndex * step + step / 2;
          const y = candleY(price, low, span, chart.top, chart.height);
          const isBuy = trade.side === "buy";

          return (
            <g className={isBuy ? "trade-marker buy-marker" : "trade-marker sell-marker"} key={trade.id}>
              <line x1={x} x2={x} y1={chart.top} y2={chart.top + chart.height} />
              <path d={isBuy ? `M ${x} ${y - 13} L ${x - 7} ${y} L ${x + 7} ${y} Z` : `M ${x} ${y + 13} L ${x - 7} ${y} L ${x + 7} ${y} Z`} />
              <rect x={x - 20} y={isBuy ? y - 38 : y + 16} width="40" height="18" rx="2" />
              <text x={x} y={isBuy ? y - 25 : y + 29} textAnchor="middle">
                {isBuy ? "BUY" : "SELL"}
              </text>
            </g>
          );
        })}
      <g className="price-badge">
        <rect x={chart.left + chart.width - 76} y={lastCloseY - 14} width="76" height="24" rx="3" />
        <text x={chart.left + chart.width - 38} y={lastCloseY + 2} textAnchor="middle">
          {priceMoney(lastClose, asset.price)}
        </text>
      </g>
      <text className="axis-label" x={chart.left} y={axisY}>
        {candles[0]?.time}
      </text>
      <text className="axis-label" x={chart.left + chart.width} y={axisY} textAnchor="end">
        {candles[candles.length - 1]?.time}
      </text>
    </svg>
  );
}

function RangeControls({
  range,
  zoom,
  onRangeChange,
  onZoomChange,
  onExpand,
  showExpand = true
}: {
  range: ChartRange;
  zoom: number;
  onRangeChange: (range: ChartRange) => void;
  onZoomChange: (zoom: number) => void;
  onExpand: () => void;
  showExpand?: boolean;
}) {
  const maxZoom = chartRanges.find((item) => item.key === range)?.points ?? 79;
  const minZoom = Math.min(maxZoom, range === "1H" ? 6 : 18);
  const sliderValue = maxZoom - Math.min(zoom, maxZoom) + minZoom;

  function setSliderZoom(value: number) {
    onZoomChange(maxZoom - value + minZoom);
  }

  return (
    <div className="chart-control-strip">
      <div className="range-tabs" aria-label="Chart time range">
        {chartRanges.map((option) => (
          <button className={option.key === range ? "selected" : ""} key={option.key} onClick={() => onRangeChange(option.key)} type="button">
            {option.label}
          </button>
        ))}
      </div>
      <div className="zoom-panel">
        <button aria-label="Zoom out" title="Zoom out: show more bars" onClick={() => onZoomChange(Math.min(maxZoom, zoom + 8))} type="button">
          <ZoomOut size={16} />
        </button>
        <input
          aria-label="Chart zoom"
          min={minZoom}
          max={maxZoom}
          step="1"
          type="range"
          value={sliderValue}
          onChange={(event) => setSliderZoom(Number(event.target.value))}
        />
        <button aria-label="Zoom in" title="Zoom in: show fewer bars" onClick={() => onZoomChange(Math.max(minZoom, zoom - 8))} type="button">
          <ZoomIn size={16} />
        </button>
      </div>
      {showExpand && (
        <button className="icon-action" aria-label="Open larger chart" onClick={onExpand} type="button">
          <Maximize2 size={16} />
        </button>
      )}
    </div>
  );
}

function RangeReadout({ asset, range, zoom, historicalCandles }: { asset: Asset; range: ChartRange; zoom: number; historicalCandles?: Candle[] }) {
  const snapshot = rangeStats(asset, range, zoom, historicalCandles);
  const config = chartRanges.find((item) => item.key === range);
  const rows = [
    ["Open", priceMoney(snapshot.first.open, asset.price)],
    ["High", priceMoney(snapshot.high, asset.price)],
    ["Low", priceMoney(snapshot.low, asset.price)],
    ["Close", priceMoney(snapshot.last.close, asset.price)],
    ["Range vol", number.format(snapshot.volume)],
    ["Window", `${snapshot.change >= 0 ? "+" : ""}${priceMoney(snapshot.change, asset.price)} (${snapshot.changePercent >= 0 ? "+" : ""}${snapshot.changePercent.toFixed(2)}%)`],
    ["Bars", `${Math.min(zoom, config?.points ?? zoom)} x ${config?.resolution ?? "bars"}`]
  ];

  return (
    <div className="range-readout">
      {rows.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong className={label === "Window" ? (snapshot.change >= 0 ? "gain" : "loss") : ""}>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function DataLoadError({ asset }: { asset: Asset }) {
  return (
    <div className="data-load-error" role="status">
      <ShieldAlert size={18} />
      <div>
        <strong>Real price unavailable for {asset.symbol}</strong>
        <span>{asset.dataError || "Stockbot could not verify a quote from the configured market data providers."}</span>
      </div>
    </div>
  );
}

function OverlayControls({ overlays, setOverlays }: { overlays: Record<ChartOverlay, boolean>; setOverlays: React.Dispatch<React.SetStateAction<Record<ChartOverlay, boolean>>> }) {
  const options: Array<{ key: ChartOverlay; label: string }> = [
    { key: "trades", label: "Trades" },
    { key: "ma", label: "MA" },
    { key: "vwap", label: "VWAP" },
    { key: "bands", label: "Bands" },
    { key: "wicks", label: "Wicks" }
  ];

  return (
    <div className="overlay-controls" aria-label="Chart overlays">
      {options.map((option) => (
        <label key={option.key}>
          <input
            checked={overlays[option.key]}
            onChange={() => setOverlays((current) => ({ ...current, [option.key]: !current[option.key] }))}
            type="checkbox"
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function DiagnosticSheet({ asset }: { asset: Asset }) {
  const rows = [
    ["RSI(14)", asset.diagnostics.rsi.toFixed(1), asset.diagnostics.rsi >= 58 ? "Momentum OK" : "Neutral"],
    ["EMA(9)", priceMoney(asset.diagnostics.emaFast, asset.price), asset.diagnostics.emaFast > asset.diagnostics.emaSlow ? "Above EMA21" : "Below EMA21"],
    ["EMA(21)", priceMoney(asset.diagnostics.emaSlow, asset.price), "Trend baseline"],
    ["VWAP", priceMoney(asset.diagnostics.vwap, asset.price), asset.price > asset.diagnostics.vwap ? "Price above VWAP" : "Price below VWAP"],
    ["ATR(14)", priceMoney(asset.diagnostics.atr, asset.price), "Volatility guard"],
    ["Signal Score", asset.diagnostics.signalScore.toFixed(1), asset.diagnostics.signalScore >= 60 ? "Trade allowed" : "Wait"]
  ];

  return (
    <section className="technical-sheet">
      <div className="section-title">
        <span>Algorithm Diagnostics</span>
        <SlidersHorizontal size={16} />
      </div>
      <div className="formula-grid">
        <strong>Metric</strong>
        <strong>Value</strong>
        <strong>Rule State</strong>
        {rows.map(([metric, value, state]) => (
          <React.Fragment key={metric}>
            <span>{metric}</span>
            <span>{value}</span>
            <span>{state}</span>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function TradeTraceSheet({ trades, strategyName }: { trades: AlgorithmTrade[]; strategyName: string }) {
  return (
    <section className="trade-trace">
      <div className="section-title">
        <span>{strategyName} Trade Trace</span>
        <Table2 size={16} />
      </div>
      <div className="trade-grid">
        <strong>Time</strong>
        <strong>Side</strong>
        <strong>Price</strong>
        <strong>Qty</strong>
        <strong>Confidence</strong>
        <strong>P/L</strong>
        <strong>Rule Trigger</strong>
        {trades.length === 0 ? (
          <span className="empty-row">No trades for this strategy window.</span>
        ) : (
          trades.map((trade) => (
            <React.Fragment key={trade.id}>
              <span>{trade.time}</span>
              <span className={trade.side === "buy" ? "gain" : "loss"}>{trade.side.toUpperCase()}</span>
              <span>{priceMoney(trade.price)}</span>
              <span>{trade.quantity}</span>
              <span>{trade.confidence}%</span>
              <span className={trade.pnlPercent >= 0 ? "gain" : "loss"}>
                {trade.pnlPercent >= 0 ? "+" : ""}
                {trade.pnlPercent}%
              </span>
              <span>{trade.rule}</span>
            </React.Fragment>
          ))
        )}
      </div>
    </section>
  );
}

function StrategySelector({
  strategies,
  selectedStrategyName,
  onSelect
}: {
  strategies: StrategyScore[];
  selectedStrategyName: string;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="strategy-selector" aria-label="Algorithm strategy">
      {strategies.map((strategy) => (
        <button className={strategy.name === selectedStrategyName ? "selected" : ""} key={strategy.name} onClick={() => onSelect(strategy.name)} type="button">
          <span>{strategy.type}</span>
          <strong>{strategy.name}</strong>
          <i className={strategy.returnPercent >= 0 ? "gain" : "loss"}>
            {strategy.returnPercent >= 0 ? "+" : ""}
            {strategy.returnPercent}%
          </i>
        </button>
      ))}
    </div>
  );
}

function CandleCalculationSheet({
  asset,
  range,
  zoom,
  trades,
  historicalCandles,
  savedCandles,
  onClearSaved
}: {
  asset: Asset;
  range: ChartRange;
  zoom: number;
  trades: AlgorithmTrade[];
  historicalCandles?: Candle[];
  savedCandles: SavedCandle[];
  onClearSaved: () => void;
}) {
  const rows = calculationRows(asset, range, zoom, trades, historicalCandles).slice(-48);

  return (
    <section className="calculation-sheet">
      <div className="section-title">
        <span>Candle Calculation Sheet</span>
        <Table2 size={16} />
      </div>
      <div className="saved-strip">
        <strong>Saved candle times</strong>
        <button onClick={onClearSaved} type="button">Clear</button>
      </div>
      <div className="saved-grid">
        <strong>Symbol</strong>
        <strong>Strategy</strong>
        <strong>Range</strong>
        <strong>Time</strong>
        <strong>Close</strong>
        <strong>Body %</strong>
        <strong>Range %</strong>
        {savedCandles.length === 0 ? (
          <span className="empty-row">Click any candle on the chart to save its time and OHLC snapshot.</span>
        ) : (
          savedCandles.map((saved) => (
            <React.Fragment key={saved.id}>
              <span>{saved.symbol}</span>
              <span>{saved.strategyName}</span>
              <span>{saved.range}</span>
              <span>{saved.time}</span>
              <span>{priceMoney(saved.close, saved.close)}</span>
              <span className={saved.bodyPercent >= 0 ? "gain" : "loss"}>
                {saved.bodyPercent >= 0 ? "+" : ""}
                {saved.bodyPercent}%
              </span>
              <span>{saved.rangePercent}%</span>
            </React.Fragment>
          ))
        )}
      </div>
      <div className="calc-grid">
        <strong>#</strong>
        <strong>Time</strong>
        <strong>Open</strong>
        <strong>High</strong>
        <strong>Low</strong>
        <strong>Close</strong>
        <strong>Volume</strong>
        <strong>Body %</strong>
        <strong>Range %</strong>
        <strong>Wick %</strong>
        <strong>MA8</strong>
        <strong>VWAP</strong>
        <strong>Trade</strong>
        {rows.map((row) => (
          <React.Fragment key={`${row.candle.time}-${row.index}`}>
            <span>{row.index + 1}</span>
            <span>{row.candle.time}</span>
            <span>{priceMoney(row.candle.open, asset.price)}</span>
            <span>{priceMoney(row.candle.high, asset.price)}</span>
            <span>{priceMoney(row.candle.low, asset.price)}</span>
            <span>{priceMoney(row.candle.close, asset.price)}</span>
            <span>{number.format(row.candle.volume)}</span>
            <span className={row.bodyPercent >= 0 ? "gain" : "loss"}>
              {row.bodyPercent >= 0 ? "+" : ""}
              {row.bodyPercent.toFixed(3)}%
            </span>
            <span>{row.rangePercent.toFixed(3)}%</span>
            <span>{row.wickPercent.toFixed(3)}%</span>
            <span>{priceMoney(row.ma8, asset.price)}</span>
            <span>{priceMoney(row.vwap, asset.price)}</span>
            <span>{row.trade}</span>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function BacktestProgress({ backtest, status }: { backtest: BacktestResult | null; status: string }) {
  const curve = backtest?.equityCurve.slice(-8) ?? [];

  return (
    <section className="backtest-progress">
      <div className="section-title">
        <span>Historical Backtest Progress</span>
        <Activity size={16} />
      </div>
      <div className="backtest-status">{status}</div>
      {backtest?.metrics && (
        <>
          <div className="backtest-metrics">
            <div>
              <span>Return</span>
              <strong className={backtest.metrics.returnPercent >= 0 ? "gain" : "loss"}>
                {backtest.metrics.returnPercent >= 0 ? "+" : ""}
                {backtest.metrics.returnPercent}%
              </strong>
            </div>
            <div>
              <span>Final equity</span>
              <strong>{money.format(backtest.metrics.finalEquity)}</strong>
            </div>
            <div>
              <span>Trades</span>
              <strong>{backtest.metrics.tradeCount}</strong>
            </div>
            <div>
              <span>Position</span>
              <strong>{backtest.metrics.openPosition ? "Open" : "Flat"}</strong>
            </div>
          </div>
          <div className="equity-grid">
            <strong>Time</strong>
            <strong>Equity</strong>
            <strong>Cash</strong>
            <strong>Position</strong>
            {curve.map((point, index) => (
              <React.Fragment key={`${point.time}-${index}`}>
                <span>{point.time}</span>
                <span>{money.format(point.equity)}</span>
                <span>{money.format(point.cash)}</span>
                <span>{money.format(point.positionValue)}</span>
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SettingsModal({
  settings,
  draft,
  status,
  onChange,
  onClose,
  onSave,
  onTestAlpaca
}: {
  settings: SettingsPayload | null;
  draft: Record<string, string>;
  status: string;
  onChange: (key: string, value: string) => void;
  onClose: () => void;
  onSave: () => void;
  onTestAlpaca: () => void;
}) {
  return (
    <section className="settings-overlay" role="dialog" aria-label="Stockbot settings">
      <div className="settings-modal">
        <header className="settings-header">
          <div>
            <span>Local configuration</span>
            <strong>Settings and accounts</strong>
          </div>
          <button className="icon-action" aria-label="Close settings" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        <div className="settings-status">
          <span>{settings?.envFilePresent ? "Local .env detected" : "No local .env yet"}</span>
          <strong>{status || "Secrets are saved only to your ignored local .env file."}</strong>
        </div>
        <div className="settings-groups">
          {settings?.groups.map((group) => (
            <section className="settings-group" key={group.id}>
              <div className="section-title">
                <span>{group.label}</span>
              </div>
              <div className="settings-grid">
                {group.fields.map((field) => (
                  <label key={field.key}>
                    <span>{field.label}</span>
                    <input
                      autoComplete="off"
                      onChange={(event) => onChange(field.key, event.target.value)}
                      placeholder={field.secret ? field.maskedValue || field.placeholder || "Not saved" : field.placeholder}
                      type={field.secret ? "password" : "text"}
                      value={draft[field.key] ?? ""}
                    />
                    <small>{field.secret && field.hasValue ? field.maskedValue : field.key}</small>
                  </label>
                ))}
              </div>
              {group.id === "alpaca" && (
                <button className="secondary-action" onClick={onTestAlpaca} type="button">
                  Test Alpaca
                </button>
              )}
            </section>
          ))}
        </div>
        <footer className="settings-footer">
          <button className="secondary-action" onClick={onClose} type="button">Cancel</button>
          <button className="primary-action" onClick={onSave} type="button">Save local settings</button>
        </footer>
      </div>
    </section>
  );
}

function MiniCandles({ asset }: { asset: Asset }) {
  const candles = asset.candles.slice(-28);
  const high = Math.max(...candles.map((candle) => candle.high));
  const low = Math.min(...candles.map((candle) => candle.low));
  const span = high - low || 1;
  const step = 116 / candles.length;

  return (
    <svg className="mini-candles" viewBox="0 0 128 54" role="img" aria-label={`${asset.symbol} mini chart`}>
      {candles.map((candle, index) => {
        const x = 6 + index * step + step / 2;
        const open = candleY(candle.open, low, span, 6, 34);
        const close = candleY(candle.close, low, span, 6, 34);
        const highY = candleY(candle.high, low, span, 6, 34);
        const lowY = candleY(candle.low, low, span, 6, 34);
        const positive = candle.close >= candle.open;
        return (
          <g key={`${asset.symbol}-${index}`} className={positive ? "candle-up" : "candle-down"}>
            <line className="wick" x1={x} x2={x} y1={highY} y2={lowY} />
            <rect className="candle-body" x={x - 1.1} y={Math.min(open, close)} width="2.2" height={Math.max(1, Math.abs(open - close))} />
          </g>
        );
      })}
    </svg>
  );
}

function MethodBoard({ strategies }: { strategies: StrategyScore[] }) {
  const [visibleMetrics, setVisibleMetrics] = React.useState<MethodMetricKey[]>([
    "returnPercent",
    "winRate",
    "maxDrawdown",
    "sharpe",
    "profitFactor"
  ]);
  const bestReturn = Math.max(...strategies.map((strategy) => Math.abs(strategy.returnPercent)), 1);
  const visibleColumns = methodMetrics.filter((metric) => visibleMetrics.includes(metric.key));

  function toggleMetric(metric: MethodMetricKey) {
    setVisibleMetrics((current) => {
      if (current.includes(metric)) {
        return current.length === 1 ? current : current.filter((item) => item !== metric);
      }
      return [...current, metric];
    });
  }

  return (
    <section className="method-board">
      <div className="section-title">
        <span>Methods Matrix</span>
        <Table2 size={16} />
      </div>
      <div className="metric-toggles" aria-label="Toggle method metrics">
        {methodMetrics.map((metric) => (
          <label key={metric.key}>
            <input checked={visibleMetrics.includes(metric.key)} onChange={() => toggleMetric(metric.key)} type="checkbox" />
            <span>{metric.label}</span>
          </label>
        ))}
      </div>
      <div className="sheet-grid" style={{ gridTemplateColumns: `minmax(180px, 1.35fr) 0.72fr repeat(${visibleColumns.length}, minmax(86px, 0.7fr))` }}>
        <strong>Method</strong>
        <strong>Class</strong>
        {visibleColumns.map((metric) => (
          <strong key={metric.key}>{metric.label}</strong>
        ))}
        {strategies.map((strategy) => (
          <React.Fragment key={strategy.name}>
            <span>{strategy.name}</span>
            <span>{strategy.type}</span>
            {visibleColumns.map((metric) => (
              <span
                className={["returnPercent", "avgTradePercent", "sharpe"].includes(metric.key) ? (Number(strategy[metric.key]) >= 0 ? "gain" : "loss") : ""}
                key={`${strategy.name}-${metric.key}`}
              >
                {metric.format(strategy)}
              </span>
            ))}
            <i className="sheet-bar" style={{ width: `${Math.abs(strategy.returnPercent / bestReturn) * 100}%` }} />
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function PanelFrame({
  panelId,
  children,
  onClose,
  onDragStart,
  onDragOver,
  onDrop
}: {
  panelId: PanelId;
  children: React.ReactNode;
  onClose: (panelId: PanelId) => void;
  onDragStart: (panelId: PanelId) => void;
  onDragOver: (panelId: PanelId) => void;
  onDrop: () => void;
}) {
  return (
    <div className={`workspace-panel ${panelSpan(panelId)}`}>
      <div
        className="panel-toolbar"
        onDragOver={(event) => {
          event.preventDefault();
          onDragOver(panelId);
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDrop();
        }}
      >
        <span
          className="panel-drag-handle"
          draggable
          onDragEnd={onDrop}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move";
            onDragStart(panelId);
          }}
        >
          <GripVertical size={14} />
          {panelLabels[panelId]}
        </span>
        <button aria-label={`Close ${panelLabels[panelId]}`} onClick={() => onClose(panelId)} type="button">
          <X size={14} />
        </button>
      </div>
      {children}
    </div>
  );
}

function App() {
  const [assets, setAssets] = React.useState<Asset[]>([]);
  const [portfolio, setPortfolio] = React.useState<Portfolio | null>(null);
  const [strategies, setStrategies] = React.useState<StrategyScore[]>([]);
  const [selectedStrategyName, setSelectedStrategyName] = React.useState("Stockbot Momentum");
  const [assetUniverse, setAssetUniverse] = React.useState({ source: "local", assetCount: 0 });
  const [query, setQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<Asset[]>([]);
  const [selectedSymbol, setSelectedSymbol] = React.useState(defaultTabs[0]);
  const [activeSymbols, setActiveSymbols] = React.useState(defaultTabs);
  const [zoom, setZoom] = React.useState(56);
  const [chartRange, setChartRange] = React.useState<ChartRange>("1D");
  const [focusedChartOpen, setFocusedChartOpen] = React.useState(false);
  const [analysisTab, setAnalysisTab] = React.useState<AnalysisTab>("trace");
  const [savedCandles, setSavedCandles] = React.useState<SavedCandle[]>([]);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsPayload, setSettingsPayload] = React.useState<SettingsPayload | null>(null);
  const [settingsDraft, setSettingsDraft] = React.useState<Record<string, string>>({});
  const [settingsStatus, setSettingsStatus] = React.useState("");
  const [backtest, setBacktest] = React.useState<BacktestResult | null>(null);
  const [backtestStatus, setBacktestStatus] = React.useState("Configure Alpaca in Settings to run historical Stockbot Momentum.");
  const [panelOrder, setPanelOrder] = React.useState<PanelId[]>(defaultPanelOrder);
  const [closedPanels, setClosedPanels] = React.useState<PanelId[]>([]);
  const [overlays, setOverlays] = React.useState<Record<ChartOverlay, boolean>>({
    trades: true,
    ma: true,
    vwap: true,
    bands: true,
    wicks: true
  });
  const [notice, setNotice] = React.useState("Live paper monitor online");
  const requestCache = React.useRef(new Map<string, CacheEntry<unknown>>());
  const draggedPanel = React.useRef<PanelId | null>(null);

  const selected = assets.find((asset) => asset.symbol === selectedSymbol) ?? assets[0] ?? null;
  const selectedHasRealData = hasRealMarketData(selected);
  const visiblePanels = panelOrder.filter((panelId) => !closedPanels.includes(panelId));
  const activeAssets = activeSymbols.map((symbol) => assets.find((asset) => asset.symbol === symbol)).filter(Boolean) as Asset[];
  const visibleSidebarAssets = query.trim() ? searchResults : assets.slice(0, 12);
  const signal = selected && selectedHasRealData ? evaluateStockbotMomentum(selected) : null;
  const baselines = selected && selectedHasRealData ? compareBaselines(selected) : [];
  const selectedStrategy = strategies.find((strategy) => strategy.name === selectedStrategyName) ?? strategies[0] ?? null;
  const isStockbotMomentum = selectedStrategy?.name === "Stockbot Momentum";
  const historicalCandles = selectedHasRealData && isStockbotMomentum && backtest?.symbol === selected?.symbol && backtest.range === chartRange ? backtest.bars : undefined;
  const strategyTrades = selected && selectedHasRealData && selectedStrategy ? (isStockbotMomentum ? backtest?.trades ?? [] : buildStrategyTrades(selected, selectedStrategy.name)) : [];
  const selectedSavedCandles = selected ? savedCandles.filter((saved) => saved.symbol === selected.symbol) : [];

  async function cachedJson<T>(url: string, ttl: number, options?: { force?: boolean }) {
    const cached = requestCache.current.get(url) as CacheEntry<T> | undefined;
    if (!options?.force && cached && Date.now() - cached.at < ttl) {
      return cached.data;
    }
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    requestCache.current.set(url, { at: Date.now(), data: payload });
    return payload as T;
  }

  const loadMarket = React.useCallback(async () => {
    const activeSymbolRequests = activeSymbols
      .filter((symbol) => symbol !== selectedSymbol)
      .map(async (symbol) => {
        try {
          const payload = await cachedJson<{ data: Asset | null }>(`/api/market/symbol/${encodeURIComponent(symbol)}`, cacheTtl.market);
          return payload.data as Asset | null;
        } catch {
          return null;
        }
      });
    const [moversPayload, selectedPayload, activeSymbolAssets] = await Promise.all([
      cachedJson<{ data: Asset[]; meta?: { source: string; assetCount: number } }>("/api/market/movers", cacheTtl.market),
      cachedJson<{ data: Asset | null }>(`/api/market/symbol/${encodeURIComponent(selectedSymbol)}`, cacheTtl.market),
      Promise.all(activeSymbolRequests)
    ]);
    const latestAssets = [
      ...(selectedPayload.data ? [selectedPayload.data] : []),
      ...activeSymbolAssets.filter(Boolean),
      ...(moversPayload.data ?? [])
    ] as Asset[];
    setAssets((current) => mergeAssets(latestAssets, current.filter((asset) => activeSymbols.includes(asset.symbol) || asset.symbol === selectedSymbol)));
    if (moversPayload.meta) {
      setAssetUniverse(moversPayload.meta);
    }
  }, [activeSymbols, selectedSymbol]);

  const loadPortfolio = React.useCallback(async () => {
    if (closedPanels.includes("portfolio")) {
      return;
    }
    const payload = await cachedJson<{ data: Portfolio }>("/api/portfolio", cacheTtl.portfolio);
    setPortfolio(payload.data);
  }, [closedPanels]);

  const loadStrategies = React.useCallback(async () => {
    if (closedPanels.includes("signal") && closedPanels.includes("methods")) {
      return;
    }
    const payload = await cachedJson<{ data: StrategyScore[] }>("/api/strategies", cacheTtl.strategies);
    setStrategies(payload.data);
    if (payload.data.length > 0 && !payload.data.some((strategy) => strategy.name === selectedStrategyName)) {
      setSelectedStrategyName(payload.data[0].name);
    }
  }, [closedPanels, selectedStrategyName]);

  React.useEffect(() => {
    loadMarket().catch(() => setNotice("Unable to reach Stockbot API"));
    const timer = window.setInterval(() => {
      loadMarket().catch(() => setNotice("Market refresh failed"));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadMarket]);

  React.useEffect(() => {
    loadPortfolio().catch(() => setNotice("Portfolio refresh failed"));
    const timer = window.setInterval(() => {
      loadPortfolio().catch(() => setNotice("Portfolio refresh failed"));
    }, 6000);
    return () => window.clearInterval(timer);
  }, [loadPortfolio]);

  React.useEffect(() => {
    loadStrategies().catch(() => setNotice("Strategy refresh failed"));
    const timer = window.setInterval(() => {
      loadStrategies().catch(() => setNotice("Strategy refresh failed"));
    }, 60000);
    return () => window.clearInterval(timer);
  }, [loadStrategies]);

  async function loadSettings() {
    const payload = await cachedJson<{ data: SettingsPayload }>("/api/settings", cacheTtl.settings);
    const nextSettings = payload.data as SettingsPayload;
    const nextDraft: Record<string, string> = {};
    for (const group of nextSettings.groups) {
      for (const field of group.fields) {
        nextDraft[field.key] = field.secret ? "" : field.value;
      }
    }
    setSettingsPayload(nextSettings);
    setSettingsDraft(nextDraft);
  }

  async function openSettings() {
    setSettingsStatus("");
    await loadSettings();
    setSettingsOpen(true);
  }

  async function saveSettings() {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: settingsDraft })
    });
    const payload = await response.json();
    requestCache.current.clear();
    setSettingsPayload(payload.data);
    setSettingsStatus(response.ok ? "Saved to local .env. Runtime settings refreshed." : "Unable to save settings.");
    loadMarket().catch(() => setNotice("Market refresh failed after settings save"));
  }

  async function testAlpacaSettings() {
    setSettingsStatus("Testing Alpaca credentials...");
    const response = await fetch("/api/settings/test/alpaca", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settingsDraft)
    });
    const payload = await response.json();
    setSettingsStatus(payload.ok ? "Alpaca connection succeeded." : `Alpaca test failed${payload.error ? `: ${payload.error}` : ""}`);
  }

  React.useEffect(() => {
    const value = query.trim();
    if (!value) {
      setSearchResults([]);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const payload = await cachedJson<{ data: Asset[]; meta?: { source: string; assetCount: number } }>(`/api/market/search?query=${encodeURIComponent(value)}`, cacheTtl.search);
        setSearchResults(payload.data ?? []);
        if (payload.meta) {
          setAssetUniverse(payload.meta);
        }
      } catch {
        setSearchResults([]);
        setNotice("Search request failed");
      }
    }, 120);

    return () => window.clearTimeout(timer);
  }, [query]);

  React.useEffect(() => {
    if (!selected || !selectedHasRealData || !isStockbotMomentum || (closedPanels.includes("chart") && closedPanels.includes("analysis"))) {
      setBacktest(null);
      if (selected && !selectedHasRealData) {
        setBacktestStatus("Real quote unavailable. Historical backtest paused until market data loads.");
      }
      return;
    }

    let cancelled = false;
    setBacktestStatus("Loading historical Stockbot Momentum backtest...");
    cachedJson<{ data: BacktestResult }>(`/api/backtest/${encodeURIComponent(selected.symbol)}?range=${encodeURIComponent(chartRange)}`, cacheTtl.backtest)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setBacktest(payload.data);
        setBacktestStatus(`Historical backtest loaded from ${payload.data.source}.`);
      })
      .catch((error) => {
        if (!cancelled) {
          setBacktest(null);
          setBacktestStatus(error.message || "Historical backtest request failed.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chartRange, closedPanels, isStockbotMomentum, selected?.symbol, selectedHasRealData]);

  function openTab(symbol: string) {
    setSelectedSymbol(symbol);
    setActiveSymbols((current) => {
      if (current.includes(symbol)) {
        return current;
      }
      return [...current.slice(-5), symbol];
    });
  }

  function openSearchResult(asset: Asset) {
    setAssets((current) => mergeAssets([asset], current));
    openTab(asset.symbol);
    setQuery("");
    setSearchResults([]);
  }

  function submitSearch(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") {
      return;
    }
    const firstResult = searchResults[0] ?? visibleSidebarAssets[0];
    if (firstResult) {
      openSearchResult(firstResult);
    }
  }

  async function liquidateAll() {
    const response = await fetch("/api/failsafe/liquidate", { method: "POST" });
    const payload = await response.json();
    requestCache.current.delete("/api/portfolio");
    setPortfolio(payload.data.portfolio);
    setNotice(payload.data.closed > 0 ? `Failsafe sold ${payload.data.closed} open positions` : "Failsafe checked: no open positions");
  }

  function changeChartRange(range: ChartRange) {
    const points = chartRanges.find((item) => item.key === range)?.points ?? 79;
    setChartRange(range);
    setZoom(points);
  }

  function saveCandle(candle: Candle, candleIndex: number) {
    if (!selected) {
      return;
    }
    const strategyName = selectedStrategy?.name ?? "Strategy";
    const saved = buildSavedCandle(selected, strategyName, chartRange, candle, candleIndex);
    setSavedCandles((current) => [saved, ...current.filter((item) => !(item.symbol === saved.symbol && item.strategyName === saved.strategyName && item.range === saved.range && item.time === saved.time))].slice(0, 24));
    setAnalysisTab("calculations");
  }

  function closePanel(panelId: PanelId) {
    setClosedPanels((current) => (current.includes(panelId) ? current : [...current, panelId]));
  }

  function restorePanel(panelId: PanelId) {
    setClosedPanels((current) => current.filter((item) => item !== panelId));
  }

  function startPanelDrag(panelId: PanelId) {
    draggedPanel.current = panelId;
  }

  function movePanelOver(targetPanel: PanelId) {
    const sourcePanel = draggedPanel.current;
    if (!sourcePanel || sourcePanel === targetPanel) {
      return;
    }
    setPanelOrder((current) => {
      const next = current.filter((panelId) => panelId !== sourcePanel);
      const targetIndex = next.indexOf(targetPanel);
      if (targetIndex === -1) {
        return current;
      }
      next.splice(targetIndex, 0, sourcePanel);
      return next;
    });
  }

  function finishPanelDrag() {
    draggedPanel.current = null;
  }

  function handleChartWheel(event: React.WheelEvent<HTMLElement>) {
    if (!selectedHasRealData) {
      return;
    }
    event.preventDefault();
    const maxZoom = chartRanges.find((item) => item.key === chartRange)?.points ?? 79;
    const minZoom = Math.min(maxZoom, chartRange === "1H" ? 6 : 18);
    const step = event.shiftKey ? 3 : 8;
    setZoom((current) => {
      if (event.deltaY < 0) {
        return Math.max(minZoom, current - step);
      }
      return Math.min(maxZoom, current + step);
    });
  }

  function renderPanel(panelId: PanelId) {
    if (panelId === "chart") {
      return selected ? (
        <section className="chart-panel stock-panel" onWheel={handleChartWheel}>
          <div className="asset-heading">
            <div>
              <p>{selected.name}</p>
              <div className="stock-title-row">
                <strong>{selected.symbol}</strong>
                <span>{assetPriceLabel(selected)}</span>
                {hasRealMarketData(selected) ? (
                  <i className={selected.changePercent >= 0 ? "gain" : "loss"}>
                    {selected.changePercent >= 0 ? "+" : ""}
                    {selected.changePercent}% today
                  </i>
                ) : (
                  <i className="loss">Quote load error</i>
                )}
              </div>
            </div>
            <RangeControls range={chartRange} zoom={zoom} onRangeChange={changeChartRange} onZoomChange={setZoom} onExpand={() => setFocusedChartOpen(true)} />
          </div>
          {hasRealMarketData(selected) ? (
            <>
              <OverlayControls overlays={overlays} setOverlays={setOverlays} />
              <CandlestickChart asset={selected} historicalCandles={historicalCandles} onSaveCandle={saveCandle} overlays={overlays} range={chartRange} trades={strategyTrades} zoom={zoom} />
              <RangeReadout asset={selected} historicalCandles={historicalCandles} range={chartRange} zoom={zoom} />
              {isStockbotMomentum && <BacktestProgress backtest={backtest} status={backtestStatus} />}
              <div className="stats-grid">
                <div>
                  <span>Volume</span>
                  <strong>{number.format(selected.volume)}</strong>
                </div>
                <div>
                  <span>Previous close</span>
                  <strong>{priceMoney(selected.previousClose, selected.price)}</strong>
                </div>
                <div>
                  <span>Source</span>
                  <strong>{selected.dataSource || "Configured provider"}</strong>
                </div>
                <div>
                  <span>Quote time</span>
                  <strong>{selected.quoteTime ? new Date(selected.quoteTime).toLocaleString() : "--"}</strong>
                </div>
              </div>
            </>
          ) : (
            <DataLoadError asset={selected} />
          )}
        </section>
      ) : null;
    }

    if (panelId === "analysis") {
      return selected && hasRealMarketData(selected) ? (
        <section className="analysis-panel">
          <div className="analysis-tabs" aria-label="Detailed analysis tabs">
            <button className={analysisTab === "trace" ? "selected" : ""} onClick={() => setAnalysisTab("trace")} type="button">Trade Trace</button>
            <button className={analysisTab === "calculations" ? "selected" : ""} onClick={() => setAnalysisTab("calculations")} type="button">Calculations</button>
          </div>
          {analysisTab === "trace" ? (
            <div className="analysis-grid">
              <DiagnosticSheet asset={selected} />
              <TradeTraceSheet strategyName={selectedStrategy?.name ?? "Strategy"} trades={strategyTrades} />
            </div>
          ) : (
            <CandleCalculationSheet
              asset={selected}
              historicalCandles={historicalCandles}
              onClearSaved={() => setSavedCandles((current) => current.filter((saved) => saved.symbol !== selected.symbol))}
              range={chartRange}
              savedCandles={selectedSavedCandles}
              trades={strategyTrades}
              zoom={zoom}
            />
          )}
        </section>
      ) : null;
    }

    if (panelId === "multiCharts") {
      return (
        <section className="multi-chart-grid">
          {activeAssets.map((asset) => (
            <button key={asset.symbol} className={`mini-chart-card ${selected?.symbol === asset.symbol ? "selected" : ""}`} onClick={() => openTab(asset.symbol)}>
              <span>{asset.symbol}</span>
              {hasRealMarketData(asset) ? (
                <>
                  <strong>{priceMoney(asset.price)}</strong>
                  <MiniCandles asset={asset} />
                </>
              ) : (
                <>
                  <strong className="loss">Load error</strong>
                  <span className="mini-load-error">Quote unavailable</span>
                </>
              )}
            </button>
          ))}
        </section>
      );
    }

    if (panelId === "portfolio") {
      return (
        <div className="portfolio-panel">
          <div className="section-title">
            <span>Portfolio</span>
            <BarChart3 size={16} />
          </div>
          {portfolio && (
            <>
              <div className="account-grid">
                <div>
                  <span>Equity</span>
                  <strong>{money.format(portfolio.equity)}</strong>
                </div>
                <div>
                  <span>Cash</span>
                  <strong>{money.format(portfolio.cash)}</strong>
                </div>
                <div>
                  <span>Realized P/L</span>
                  <strong className={portfolio.realizedPnl >= 0 ? "gain" : "loss"}>{money.format(portfolio.realizedPnl)}</strong>
                </div>
              </div>
              <div className="position-list">
                {portfolio.positions.length === 0 ? (
                  <p className="empty-state">No algorithm positions open.</p>
                ) : (
                  portfolio.positions.map((position) => (
                    <div className="position-row" key={position.symbol}>
                      <strong>{position.symbol}</strong>
                      <span>{position.qty} shares</span>
                      <span>{money.format(position.marketValue)}</span>
                      <span className={position.unrealizedPnl >= 0 ? "gain" : "loss"}>{money.format(position.unrealizedPnl)}</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      );
    }

    if (panelId === "signal") {
      return (
        <div className="strategy-panel">
          <div className="section-title">
            <span>Signal</span>
            <Activity size={16} />
          </div>
          <StrategySelector strategies={strategies} selectedStrategyName={selectedStrategyName} onSelect={setSelectedStrategyName} />
          {signal && selected && hasRealMarketData(selected) && (
            <div className="signal-card">
              <span>Stockbot Momentum</span>
              <strong>{signal.action.toUpperCase()}</strong>
              <p>{signal.reason}</p>
              <div className="meter">
                <i style={{ width: `${signal.conviction}%` }} />
              </div>
            </div>
          )}
          <div className="baseline-strip">
            {baselines.map((baseline) => (
              <span key={baseline.name}>{baseline.name}</span>
            ))}
          </div>
        </div>
      );
    }

    return <MethodBoard strategies={strategies} />;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">
            <LineChart size={21} />
          </div>
          <div>
            <strong>Stockbot</strong>
            <span>Algorithm monitor</span>
          </div>
        </div>

        <label className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={submitSearch}
            placeholder="Search any Alpaca stock"
          />
        </label>
        <div className="asset-universe">
          <span>{assetUniverse.source === "alpaca" ? "Alpaca" : "Local"} universe</span>
          <strong>{number.format(assetUniverse.assetCount || assets.length)} assets</strong>
        </div>

        <section className="watchlist">
          <div className="section-title">
            <span>{query.trim() ? "Search Results" : "Latest Movers"}</span>
            <Activity size={16} />
          </div>
          {visibleSidebarAssets.map((asset) => (
            <button className={`asset-row ${selected?.symbol === asset.symbol ? "active" : ""}`} key={asset.symbol} onClick={() => openSearchResult(asset)}>
              <div>
                <strong>{asset.symbol}</strong>
                <span>{asset.name}</span>
                {query.trim() && <small>{asset.matchReason || asset.sector}</small>}
              </div>
              <div className="asset-price">
                <strong className={hasRealMarketData(asset) ? "" : "loss"}>{assetPriceLabel(asset)}</strong>
                {hasRealMarketData(asset) ? (
                  <span className={asset.changePercent >= 0 ? "gain" : "loss"}>
                    {asset.changePercent >= 0 ? "+" : ""}
                    {asset.changePercent}%
                  </span>
                ) : (
                  <span className="loss">Quote unavailable</span>
                )}
              </div>
            </button>
          ))}
          {query.trim() && visibleSidebarAssets.length === 0 && <p className="empty-state">No matches. Try company name, sector, or nickname.</p>}
        </section>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Live Strategy Cockpit</p>
            <h1>{selected ? `${selected.symbol} ${assetPriceLabel(selected)}` : "Loading market"}</h1>
          </div>
          <div className="status-row">
            <div className="status-pill">
              <Activity size={16} />
              <span>{notice}</span>
            </div>
            <button className="settings-button" onClick={openSettings} type="button">
              <Settings size={17} />
              Settings
            </button>
            <button className="failsafe-button" onClick={liquidateAll} type="button">
              <ShieldAlert size={17} />
              Exit All
            </button>
          </div>
        </header>

        <nav className="symbol-tabs" aria-label="Open stock charts">
          {activeAssets.map((asset) => (
            <button key={asset.symbol} className={selected?.symbol === asset.symbol ? "selected" : ""} onClick={() => openTab(asset.symbol)}>
              <strong>{asset.symbol}</strong>
              {hasRealMarketData(asset) ? (
                <span className={asset.changePercent >= 0 ? "gain" : "loss"}>
                  {asset.changePercent >= 0 ? "+" : ""}
                  {asset.changePercent}%
                </span>
              ) : (
                <span className="loss">Load error</span>
              )}
            </button>
          ))}
        </nav>

        {closedPanels.length > 0 && (
          <div className="panel-restore-strip" aria-label="Restore hidden panels">
            {closedPanels.map((panelId) => (
              <button key={panelId} onClick={() => restorePanel(panelId)} type="button">
                <Eye size={14} />
                {panelLabels[panelId]}
              </button>
            ))}
          </div>
        )}

        <section className="dashboard-workspace">
          {visiblePanels.map((panelId) => {
            const panel = renderPanel(panelId);
            if (!panel) {
              return null;
            }
            return (
              <PanelFrame
                key={panelId}
                panelId={panelId}
                onClose={closePanel}
                onDragOver={movePanelOver}
                onDragStart={startPanelDrag}
                onDrop={finishPanelDrag}
              >
                {panel}
              </PanelFrame>
            );
          })}
        </section>
      </section>

      {selected && focusedChartOpen && hasRealMarketData(selected) && (
        <section className="focus-overlay" aria-label={`${selected.symbol} expanded chart`} role="dialog">
          <div className="focus-chart-shell" onWheel={handleChartWheel}>
            <header className="focus-header">
              <div>
                <span>{selected.symbol}</span>
                <strong>{selected.name}</strong>
              </div>
              <div className="focus-actions">
                <RangeControls
                  range={chartRange}
                  zoom={zoom}
                  onRangeChange={changeChartRange}
                  onZoomChange={setZoom}
                  onExpand={() => setFocusedChartOpen(false)}
                  showExpand={false}
                />
                <button className="icon-action" aria-label="Close larger chart" onClick={() => setFocusedChartOpen(false)} type="button">
                  <X size={16} />
                </button>
              </div>
            </header>
            <OverlayControls overlays={overlays} setOverlays={setOverlays} />
            <CandlestickChart asset={selected} expanded historicalCandles={historicalCandles} onSaveCandle={saveCandle} overlays={overlays} range={chartRange} trades={strategyTrades} zoom={zoom} />
            <RangeReadout asset={selected} historicalCandles={historicalCandles} range={chartRange} zoom={zoom} />
          </div>
        </section>
      )}
      {settingsOpen && (
        <SettingsModal
          draft={settingsDraft}
          onChange={(key, value) => setSettingsDraft((current) => ({ ...current, [key]: value }))}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
          onTestAlpaca={testAlpacaSettings}
          settings={settingsPayload}
          status={settingsStatus}
        />
      )}
    </main>
  );
}

declare global {
  interface Window {
    __stockbotRoot?: ReactDOM.Root;
  }
}

const rootElement = document.getElementById("root")!;
const stockbotRoot = window.__stockbotRoot ?? ReactDOM.createRoot(rootElement);
window.__stockbotRoot = stockbotRoot;

stockbotRoot.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
