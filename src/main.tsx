import React from "react";
import ReactDOM from "react-dom/client";
import {
  Activity,
  BarChart3,
  Eye,
  GripVertical,
  Home,
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
import type { AlgorithmDiagnostic, AlgorithmTrade, Asset, Candle, Portfolio, StrategyScore } from "./types";
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
type ChartStyle = "candles" | "line";
type AppView = "stocks" | "home";
type PanelId = "chart" | "analysis" | "multiCharts" | "portfolio" | "signal" | "methods";
type CompareMetrics = {
  returnPercent: number;
  finalEquity: number;
  tradeCount: number;
  winRate: number | null;
  maxDrawdown: number;
  sharpe: number;
  profitFactor: number;
  exposurePercent: number;
  avgTradePercent: number;
  openPosition: boolean;
};
type CompareStrategy = {
  id: string;
  name: string;
  type: "primary" | "control";
  description?: string;
  source?: string;
  error?: string;
  equityCurve: Array<{ time: string; equity: number }>;
  trades: AlgorithmTrade[];
  lastSignal?: "buy" | "sell" | null;
  metrics: CompareMetrics | null;
};
type ScanSymbolResult = {
  symbol: string;
  error?: string;
  returnPercent?: number;
  pnl?: number;
  winRate?: number | null;
  maxDrawdown?: number;
  sharpe?: number;
  profitFactor?: number;
  exposurePercent?: number;
  avgTradePercent?: number;
  tradeCount?: number;
  openPosition?: boolean;
  recommendation?: "buy" | "sell" | "hold" | "stand by";
  lastAction?: { side: "buy" | "sell"; time: string; price: number } | null;
  trades?: AlgorithmTrade[];
};
type ScanStrategy = {
  id: string;
  name: string;
  description?: string;
  totals: { pnl: number; avgReturnPercent: number; profitableSymbols: number; scoredSymbols: number };
  perSymbol: ScanSymbolResult[];
};
type ScanResult = {
  range: ChartRange;
  symbols: string[];
  strategies: ScanStrategy[];
  algorithmErrors: AlgorithmLoadError[];
};
type HomeTab = "profits" | "detail" | "stats";
type AlgorithmLoadError = { file: string; error: string };
type CompareResult = {
  symbol: string;
  range: ChartRange;
  source: string;
  startingCash: number;
  algorithmErrors?: AlgorithmLoadError[];
  strategies: CompareStrategy[];
};
type AlgorithmInfo = {
  id: string;
  name: string;
  author?: string;
  description?: string;
  params?: Record<string, number | string>;
  defaultParams?: Record<string, number | string>;
  file: string;
  code?: string;
  uploaded: boolean;
};
type AlgorithmsPayload = {
  algorithms: AlgorithmInfo[];
  errors: AlgorithmLoadError[];
};
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
type CacheEntry<T> = {
  at: number;
  data: T;
};
type AlgorithmSymbolSettings = Record<string, Record<string, boolean>>;
type AlgorithmSortKey = "return" | "pnl" | "trades" | "winRate" | "name";

const panelLabels: Record<PanelId, string> = {
  chart: "Chart",
  analysis: "Analysis",
  multiCharts: "Tabs",
  portfolio: "Portfolio",
  signal: "Signal",
  methods: "Methods"
};
const defaultPanelOrder: PanelId[] = ["chart", "analysis", "multiCharts", "portfolio", "signal", "methods"];
const strategyPalette = ["#4d9fff", "#2ebd85", "#f0b90b", "#f6465d", "#a78bfa", "#8b95a8"];
const cacheTtl = {
  market: 1800,
  portfolio: 5000,
  strategies: 60000,
  search: 15000,
  backtest: 120000,
  bars: 60000,
  compare: 60000,
  settings: 30000
};

type BarsEntry = {
  source: string;
  bars: Candle[];
  error?: string;
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

function displayTime(time: string, range: ChartRange) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    return time;
  }
  if (range === "1H" || range === "1D") {
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (range === "1W") {
    return date.toLocaleString("en-US", { weekday: "short", hour: "numeric" });
  }
  if (range === "1M" || range === "3M" || range === "1Y") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function getVisibleCandles(asset: Asset, zoom: number, sourceCandles: Candle[]) {
  const candles = sourceCandles.map((candle) => normalizeCandle(candle, asset.price));
  return candles.slice(-Math.min(zoom, candles.length));
}

function rangeStats(asset: Asset, zoom: number, sourceCandles: Candle[]) {
  const candles = getVisibleCandles(asset, zoom, sourceCandles);
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

function calculationRows(asset: Asset, zoom: number, trades: AlgorithmTrade[], sourceCandles: Candle[]) {
  const candles = getVisibleCandles(asset, zoom, sourceCandles);
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

function getTradePoints(trades: AlgorithmTrade[], candles: Candle[]) {
  return trades
    .map((trade) => {
      let candleIndex = candles.findIndex((candle) => candle.time === trade.time);
      if (candleIndex === -1) {
        candleIndex = candles.findIndex((candle) => String(candle.time) >= String(trade.time));
      }
      return candleIndex >= 0 ? { trade, candleIndex, price: trade.price } : null;
    })
    .filter(Boolean) as Array<{ trade: AlgorithmTrade; candleIndex: number; price: number }>;
}

function CandlestickChart({
  asset,
  zoom,
  overlays,
  range,
  trades = [],
  sourceCandles,
  onSaveCandle,
  expanded = false,
  chartStyle = "candles"
}: {
  asset: Asset;
  zoom: number;
  overlays: Record<ChartOverlay, boolean>;
  range: ChartRange;
  trades: AlgorithmTrade[];
  sourceCandles: Candle[];
  onSaveCandle?: (candle: Candle, candleIndex: number) => void;
  expanded?: boolean;
  chartStyle?: ChartStyle;
}) {
  const [hoveredCandle, setHoveredCandle] = React.useState<{ candle: Candle; index: number; x: number; y: number } | null>(null);
  const candles = getVisibleCandles(asset, zoom, sourceCandles);
  const visibleTrades = getTradePoints(trades, candles);
  const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);
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
  const lineUp = (candles[candles.length - 1]?.close ?? 0) >= (candles[0]?.close ?? 0);
  const linePath = candles
    .map((candle, index) => {
      const x = chart.left + index * step + step / 2;
      const y = candleY(candle.close, low, span, chart.top, chart.height);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const areaPath = `${linePath} L ${(chart.left + (candles.length - 1) * step + step / 2).toFixed(2)} ${chart.top + chart.height} L ${(chart.left + step / 2).toFixed(2)} ${chart.top + chart.height} Z`;

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
        const volumeHeight = Math.max(2, (candle.volume / maxVolume) * (expanded ? 48 : 38));

        return (
          <g key={`${candle.time}-${index}`} className={positive ? "candle-up" : "candle-down"}>
            {chartStyle === "candles" && overlays.wicks && <line className="wick" x1={x} x2={x} y1={highY} y2={lowY} />}
            {chartStyle === "candles" && (
              <rect className="candle-body" x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} rx="1" />
            )}
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

      {chartStyle === "line" && (
        <g className={lineUp ? "price-line gain-line" : "price-line loss-line"}>
          <path className="line-area" d={areaPath} />
          <path className="line-path" d={linePath} />
        </g>
      )}
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
            <text x="8" y="17">Date / Time: {displayTime(hoveredCandle.candle.time, range)}</text>
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
          const colorStyle = trade.color ? { stroke: trade.color } : undefined;
          const fillStyle = trade.color ? { fill: trade.color } : undefined;

          return (
            <g className={isBuy ? "trade-marker buy-marker" : "trade-marker sell-marker"} key={trade.id}>
              <line style={colorStyle} x1={x} x2={x} y1={chart.top} y2={chart.top + chart.height} />
              <path style={fillStyle} d={isBuy ? `M ${x} ${y - 13} L ${x - 7} ${y} L ${x + 7} ${y} Z` : `M ${x} ${y + 13} L ${x - 7} ${y} L ${x + 7} ${y} Z`} />
              <rect style={fillStyle} x={x - 20} y={isBuy ? y - 38 : y + 16} width="40" height="18" rx="2" />
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
        {candles[0] ? displayTime(candles[0].time, range) : ""}
      </text>
      <text className="axis-label" x={chart.left + chart.width} y={axisY} textAnchor="end">
        {candles[candles.length - 1] ? displayTime(candles[candles.length - 1].time, range) : ""}
      </text>
    </svg>
  );
}

function RangeControls({
  range,
  zoom,
  chartStyle,
  onRangeChange,
  onZoomChange,
  onChartStyleChange,
  onExpand,
  showExpand = true
}: {
  range: ChartRange;
  zoom: number;
  chartStyle: ChartStyle;
  onRangeChange: (range: ChartRange) => void;
  onZoomChange: (zoom: number) => void;
  onChartStyleChange: (style: ChartStyle) => void;
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
      <div className="range-tabs" aria-label="Chart style">
        <button className={chartStyle === "line" ? "selected" : ""} onClick={() => onChartStyleChange("line")} type="button">
          Line
        </button>
        <button className={chartStyle === "candles" ? "selected" : ""} onClick={() => onChartStyleChange("candles")} type="button">
          Candles
        </button>
      </div>
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

function RangeReadout({ asset, range, zoom, sourceCandles }: { asset: Asset; range: ChartRange; zoom: number; sourceCandles: Candle[] }) {
  if (sourceCandles.length === 0) {
    return null;
  }
  const snapshot = rangeStats(asset, zoom, sourceCandles);
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

function metricValue(metric: keyof CompareMetrics, metrics: CompareMetrics | null) {
  if (!metrics) {
    return "--";
  }
  if (metric === "finalEquity") {
    return money.format(metrics.finalEquity);
  }
  if (metric === "winRate") {
    return metrics.winRate === null ? "--" : `${metrics.winRate}%`;
  }
  if (metric === "tradeCount") {
    return number.format(metrics.tradeCount);
  }
  if (metric === "openPosition") {
    return metrics.openPosition ? "Open" : "Flat";
  }
  if (metric === "sharpe" || metric === "profitFactor") {
    return metrics[metric].toFixed(2);
  }
  return `${metrics[metric] >= 0 ? "+" : ""}${metrics[metric]}%`;
}

function metricDelta(metric: keyof CompareMetrics, algorithm: CompareMetrics | null, control: CompareMetrics | null) {
  if (!algorithm || !control || metric === "openPosition" || algorithm[metric] === null || control[metric] === null) {
    return "--";
  }
  const algorithmValue = Number(algorithm[metric]);
  const controlValue = Number(control[metric]);
  if (!Number.isFinite(algorithmValue) || !Number.isFinite(controlValue)) {
    return "--";
  }
  const delta = algorithmValue - controlValue;
  if (metric === "finalEquity") {
    return money.format(delta);
  }
  if (metric === "tradeCount") {
    return number.format(delta);
  }
  if (metric === "sharpe" || metric === "profitFactor") {
    return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`;
  }
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}%`;
}

function metricWinner(metric: keyof CompareMetrics, algorithm: CompareMetrics | null, control: CompareMetrics | null) {
  if (!algorithm || !control || metric === "openPosition" || algorithm[metric] === null || control[metric] === null) {
    return "--";
  }
  const algorithmValue = Number(algorithm[metric]);
  const controlValue = Number(control[metric]);
  if (metric === "maxDrawdown") {
    return algorithmValue >= controlValue ? "Algorithm" : "Control";
  }
  if (metric === "tradeCount" || metric === "exposurePercent") {
    return algorithmValue === controlValue ? "Tie" : algorithmValue < controlValue ? "Algorithm" : "Control";
  }
  return algorithmValue === controlValue ? "Tie" : algorithmValue > controlValue ? "Algorithm" : "Control";
}

function controlCodeSnippet(controlId: string) {
  if (controlId === "control/spy") {
    return `// S&P 500 buy-and-hold control\nexport default {\n  name: "S&P 500 Index (SPY) — Control",\n  signal({ index }) {\n    return index === 1 ? "buy" : null;\n  }\n};`;
  }
  return `// Cash control\nexport default {\n  name: "Cash — Control",\n  signal() {\n    return null;\n  }\n};`;
}

function orderedCompareStrategies(strategies: CompareStrategy[]) {
  return [...strategies].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "control" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function readStoredAlgorithmSymbols() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("stockbot.algorithmSymbols") || "{}");
    return parsed && typeof parsed === "object" ? (parsed as AlgorithmSymbolSettings) : {};
  } catch {
    return {};
  }
}

function isSymbolEnabledForAlgorithm(settings: AlgorithmSymbolSettings, strategyId: string, symbol: string) {
  return settings[strategyId]?.[symbol] !== false;
}

function enabledSymbolsForStrategy(settings: AlgorithmSymbolSettings, strategyId: string, symbols: string[]) {
  return symbols.filter((symbol) => isSymbolEnabledForAlgorithm(settings, strategyId, symbol));
}

function recomputeStrategyTotals(perSymbol: ScanSymbolResult[]) {
  const scored = perSymbol.filter((entry) => !entry.error);
  const totalPnl = scored.reduce((sum, entry) => sum + (entry.pnl ?? 0), 0);
  const returnSum = scored.reduce((sum, entry) => sum + (entry.returnPercent ?? 0), 0);
  return {
    pnl: Number(totalPnl.toFixed(2)),
    avgReturnPercent: scored.length > 0 ? Number((returnSum / scored.length).toFixed(2)) : 0,
    profitableSymbols: scored.filter((entry) => (entry.pnl ?? 0) > 0).length,
    scoredSymbols: scored.length
  };
}

function filterScanResult(scan: ScanResult | null, settings: AlgorithmSymbolSettings, symbols: string[]) {
  if (!scan) {
    return null;
  }
  return {
    ...scan,
    symbols,
    strategies: scan.strategies.map((strategy) => {
      const enabled = new Set(enabledSymbolsForStrategy(settings, strategy.id, symbols));
      const perSymbol = strategy.perSymbol.filter((entry) => enabled.has(entry.symbol));
      return { ...strategy, perSymbol, totals: recomputeStrategyTotals(perSymbol) };
    })
  };
}

function bestSymbolForStrategy(strategy: ScanStrategy) {
  return strategy.perSymbol
    .filter((entry) => !entry.error && typeof entry.returnPercent === "number")
    .sort((a, b) => (b.returnPercent ?? -Infinity) - (a.returnPercent ?? -Infinity))[0] ?? null;
}

function totalTradesForStrategy(strategy: ScanStrategy) {
  return strategy.perSymbol.reduce((sum, entry) => sum + (entry.tradeCount ?? entry.trades?.length ?? 0), 0);
}

function averageWinRateForStrategy(strategy: ScanStrategy) {
  const scored = strategy.perSymbol.filter((entry) => !entry.error && typeof entry.winRate === "number");
  if (scored.length === 0) {
    return null;
  }
  return Number((scored.reduce((sum, entry) => sum + (entry.winRate ?? 0), 0) / scored.length).toFixed(1));
}

function sortStrategiesForRail(strategies: ScanStrategy[], sortKey: AlgorithmSortKey) {
  return [...strategies].sort((a, b) => {
    if (sortKey === "name") {
      return a.name.localeCompare(b.name);
    }
    const getValue = (strategy: ScanStrategy) => {
      if (sortKey === "return") {
        return strategy.totals.avgReturnPercent;
      }
      if (sortKey === "pnl") {
        return strategy.totals.pnl;
      }
      if (sortKey === "trades") {
        return totalTradesForStrategy(strategy);
      }
      return averageWinRateForStrategy(strategy) ?? -Infinity;
    };
    return getValue(b) - getValue(a) || a.name.localeCompare(b.name);
  });
}

function collectScanTrades(scan: ScanResult | null) {
  return (scan?.strategies ?? [])
    .flatMap((strategy) =>
      strategy.perSymbol
        .filter((entry) => !entry.error && (entry.trades?.length || entry.lastAction))
        .flatMap((entry) => {
          const trades = entry.trades?.length
            ? entry.trades
            : entry.lastAction
              ? [{ ...entry.lastAction, id: `${strategy.id}-${entry.symbol}-${entry.lastAction.time}`, quantity: 0, pnlPercent: entry.returnPercent ?? 0 }]
              : [];
          return trades.map((trade) => ({
          id: `${strategy.id}-${entry.symbol}-${trade.time}-${trade.side}`,
          strategyId: strategy.id,
          strategyName: strategy.name,
          symbol: entry.symbol,
          side: trade.side,
          time: trade.time,
          price: trade.price,
          rule: trade.rule,
          pnl: entry.pnl ?? 0,
          returnPercent: trade.pnlPercent ?? entry.returnPercent ?? 0,
          recommendation: entry.recommendation ?? "stand by"
          }));
        })
    )
    .sort((a, b) => String(b.time).localeCompare(String(a.time)));
}

function nearestAlgorithmTrade(trades: AlgorithmTrade[], time: string) {
  if (trades.length === 0) {
    return null;
  }
  return trades.reduce((closest, trade) => {
    const tradeDistance = Math.abs(new Date(trade.time).getTime() - new Date(time).getTime());
    const closestDistance = Math.abs(new Date(closest.time).getTime() - new Date(time).getTime());
    return tradeDistance < closestDistance ? trade : closest;
  }, trades[0]);
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

function computeDiagnostics(candles: Candle[]): AlgorithmDiagnostic {
  const last = candles[candles.length - 1];
  const fastSample = candles.slice(-9);
  const slowSample = candles.slice(-21);
  const emaFast = fastSample.reduce((sum, candle) => sum + candle.close, 0) / Math.max(fastSample.length, 1);
  const emaSlow = slowSample.reduce((sum, candle) => sum + candle.close, 0) / Math.max(slowSample.length, 1);
  const vwapNumerator = candles.reduce((sum, candle) => sum + candle.close * candle.volume, 0);
  const vwapDenominator = candles.reduce((sum, candle) => sum + candle.volume, 0) || 1;
  const ranges = candles.slice(-14).map((candle) => candle.high - candle.low);
  const atr = Math.max(ranges.reduce((sum, value) => sum + value, 0) / Math.max(ranges.length, 1), 0.0001);
  const gains = candles.slice(-14).filter((candle) => candle.close >= candle.open).length;
  const rsi = 38 + (gains / 14) * 38 + Math.min(Math.max((last.close - emaSlow) / atr, -4), 4) * 2.2;
  const signalScore = 50 + ((emaFast - emaSlow) / atr) * 12 + (last.close > vwapNumerator / vwapDenominator ? 8 : -8);

  return {
    rsi: Number(Math.max(0, Math.min(100, rsi)).toFixed(1)),
    emaFast: Number(emaFast.toFixed(2)),
    emaSlow: Number(emaSlow.toFixed(2)),
    vwap: Number((vwapNumerator / vwapDenominator).toFixed(2)),
    atr: Number(atr.toFixed(2)),
    signalScore: Number(Math.max(0, Math.min(100, signalScore)).toFixed(1))
  };
}

function DiagnosticSheet({ asset, sourceCandles }: { asset: Asset; sourceCandles: Candle[] }) {
  const diagnostics = sourceCandles.length >= 14 ? computeDiagnostics(sourceCandles) : asset.diagnostics;
  const rows = [
    ["RSI(14)", diagnostics.rsi.toFixed(1), diagnostics.rsi >= 58 ? "Momentum OK" : "Neutral"],
    ["EMA(9)", priceMoney(diagnostics.emaFast, asset.price), diagnostics.emaFast > diagnostics.emaSlow ? "Above EMA21" : "Below EMA21"],
    ["EMA(21)", priceMoney(diagnostics.emaSlow, asset.price), "Trend baseline"],
    ["VWAP", priceMoney(diagnostics.vwap, asset.price), asset.price > diagnostics.vwap ? "Price above VWAP" : "Price below VWAP"],
    ["ATR(14)", priceMoney(diagnostics.atr, asset.price), "Volatility guard"],
    ["Signal Score", diagnostics.signalScore.toFixed(1), diagnostics.signalScore >= 60 ? "Trade allowed" : "Wait"]
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

function TradeTraceSheet({ trades, range }: { trades: AlgorithmTrade[]; range: ChartRange }) {
  return (
    <section className="trade-trace">
      <div className="section-title">
        <span>Trade Trace — checked algorithms</span>
        <Table2 size={16} />
      </div>
      <div className="trade-grid">
        <strong>Time</strong>
        <strong>Side</strong>
        <strong>Price</strong>
        <strong>Qty</strong>
        <strong>Algorithm</strong>
        <strong>P/L</strong>
        <strong>Rule Trigger</strong>
        {trades.length === 0 ? (
          <span className="empty-row">No trades in this window. Check an algorithm to overlay its trades.</span>
        ) : (
          trades.map((trade) => (
            <React.Fragment key={trade.id}>
              <span>{displayTime(trade.time, range)}</span>
              <span className={trade.side === "buy" ? "gain" : "loss"}>{trade.side.toUpperCase()}</span>
              <span>{priceMoney(trade.price)}</span>
              <span>{trade.quantity}</span>
              <span>
                {trade.color && <i className="perf-dot" style={{ background: trade.color }} />}
                {trade.strategyName ?? "--"}
              </span>
              <span className={trade.pnlPercent >= 0 ? "gain" : "loss"}>
                {trade.pnlPercent >= 0 ? "+" : ""}
                {trade.pnlPercent}%
              </span>
              <span>{trade.rule ?? "--"}</span>
            </React.Fragment>
          ))
        )}
      </div>
    </section>
  );
}

function AlgorithmChecklist({
  strategies,
  checked,
  onToggle,
  range
}: {
  strategies: CompareStrategy[];
  checked: string[];
  onToggle: (name: string) => void;
  range: ChartRange;
}) {
  const markable = strategies.filter((strategy) => strategy.type === "primary");

  return (
    <div className="algo-checklist" aria-label="Algorithm trade overlays">
      {markable.length === 0 && <p className="empty-state">No algorithms loaded yet. Add files to the algorithms folder.</p>}
      {markable.map((strategy) => {
        const colorIndex = strategies.findIndex((item) => item.name === strategy.name);
        const color = strategyPalette[colorIndex % strategyPalette.length];
        const lastTrade = strategy.trades[strategy.trades.length - 1];
        return (
          <label className={checked.includes(strategy.name) ? "checked" : ""} key={strategy.name} style={{ borderLeftColor: color }}>
            <input checked={checked.includes(strategy.name)} onChange={() => onToggle(strategy.name)} type="checkbox" />
            <i style={{ background: color }} />
            <div>
              <strong>{strategy.name}</strong>
              <span>
                {strategy.error
                  ? "Backtest error"
                  : strategy.metrics
                    ? `${strategy.metrics.returnPercent >= 0 ? "+" : ""}${strategy.metrics.returnPercent}% · ${strategy.trades.length} trades${
                        lastTrade ? ` · last ${lastTrade.side.toUpperCase()} ${displayTime(lastTrade.time, range)}` : ""
                      }`
                    : "No data"}
              </span>
            </div>
            {strategy.metrics && (
              <em className={strategy.metrics.returnPercent >= 0 ? "gain" : "loss"}>
                {strategy.metrics.openPosition ? "HOLDING" : "FLAT"}
              </em>
            )}
          </label>
        );
      })}
    </div>
  );
}

function CandleCalculationSheet({
  asset,
  range,
  zoom,
  trades,
  sourceCandles,
  savedCandles,
  onClearSaved
}: {
  asset: Asset;
  range: ChartRange;
  zoom: number;
  trades: AlgorithmTrade[];
  sourceCandles: Candle[];
  savedCandles: SavedCandle[];
  onClearSaved: () => void;
}) {
  const rows = calculationRows(asset, zoom, trades, sourceCandles).slice(-48);

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
              <span>{displayTime(saved.time, saved.range)}</span>
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
            <span>{displayTime(row.candle.time, range)}</span>
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

function MiniCandles({ asset, sourceCandles }: { asset: Asset; sourceCandles: Candle[] }) {
  const candles = sourceCandles.slice(-28);
  if (candles.length === 0) {
    return <span className="mini-loading">Loading bars...</span>;
  }
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

function PerformancePanel({
  symbol,
  range,
  compare,
  status
}: {
  symbol: string;
  range: ChartRange;
  compare: CompareResult | null;
  status: string;
}) {
  const strategies = orderedCompareStrategies(compare?.strategies ?? []);
  const startingCash = compare?.startingCash ?? 100000;
  const chart = { left: 58, top: 18, width: 788, height: 240 };
  const axisY = chart.top + chart.height + 26;

  const gainOf = (equity: number) => ((equity - startingCash) / startingCash) * 100;
  const allGains = strategies.flatMap((strategy) => strategy.equityCurve.map((point) => gainOf(point.equity)));
  const maxGain = Math.max(...(allGains.length ? allGains : [0]), 0.4);
  const minGain = Math.min(...(allGains.length ? allGains : [0]), -0.4);
  const gainSpan = maxGain - minGain || 1;
  const gainY = (gain: number) => chart.top + chart.height - ((gain - minGain) / gainSpan) * chart.height;
  const firstCurve = strategies[0]?.equityCurve ?? [];

  return (
    <section className="performance-panel">
      <div className="section-title">
        <span>
          Auto-Trading Performance — {symbol} · {range} window
        </span>
        <Activity size={16} />
      </div>
      <div className="perf-status">{status}</div>
      {strategies.length > 0 && (
        <>
          <div className="perf-legend static" aria-label="Comparison series">
            {strategies.map((strategy, index) => {
              return (
                <span className={strategy.type === "control" ? "control-series" : ""} key={strategy.name}>
                  <i style={{ background: strategyPalette[index % strategyPalette.length] }} />
                  <span>{strategy.name}</span>
                  <em>{strategy.type === "control" ? "control" : "algorithm"}</em>
                  {strategy.metrics ? (
                    <strong className={strategy.metrics.returnPercent >= 0 ? "gain" : "loss"}>
                      {strategy.metrics.returnPercent >= 0 ? "+" : ""}
                      {strategy.metrics.returnPercent}%
                    </strong>
                  ) : (
                    <strong className="loss">error</strong>
                  )}
                </span>
              );
            })}
          </div>
          <svg className="perf-chart" viewBox="0 0 880 312" preserveAspectRatio="xMidYMin meet" role="img" aria-label={`${symbol} strategy gains comparison`}>
            <rect className="plot-bg" x={chart.left} y={chart.top} width={chart.width} height={chart.height} rx="3" />
            {[0, 1, 2, 3, 4].map((line) => {
              const value = maxGain - (gainSpan / 4) * line;
              const yPos = chart.top + (chart.height / 4) * line;
              return (
                <g key={line}>
                  <line className="grid-line" x1={chart.left} x2={chart.left + chart.width} y1={yPos} y2={yPos} />
                  <text className="axis-label" x={chart.left - 10} y={yPos + 4} textAnchor="end">
                    {value >= 0 ? "+" : ""}
                    {value.toFixed(1)}%
                  </text>
                </g>
              );
            })}
            {minGain < 0 && maxGain > 0 && (
              <line className="zero-line" x1={chart.left} x2={chart.left + chart.width} y1={gainY(0)} y2={gainY(0)} />
            )}
            {strategies.map((strategy, index) => {
              const points = strategy.equityCurve;
              const stepX = chart.width / Math.max(points.length - 1, 1);
              const path = points
                .map((point, pointIndex) => `${pointIndex === 0 ? "M" : "L"} ${(chart.left + pointIndex * stepX).toFixed(2)} ${gainY(gainOf(point.equity)).toFixed(2)}`)
                .join(" ");
              return <path className="perf-line" d={path} key={strategy.name} style={{ stroke: strategyPalette[index % strategyPalette.length] }} />;
            })}
            <text className="axis-label" x={chart.left} y={axisY}>
              {firstCurve[0] ? displayTime(firstCurve[0].time, range) : ""}
            </text>
            <text className="axis-label" x={chart.left + chart.width} y={axisY} textAnchor="end">
              {firstCurve[firstCurve.length - 1] ? displayTime(firstCurve[firstCurve.length - 1].time, range) : ""}
            </text>
          </svg>
          <div className="perf-grid">
            <strong>Strategy</strong>
            <strong>Class</strong>
            <strong>Return</strong>
            <strong>Win Rate</strong>
            <strong>Max DD</strong>
            <strong>Trades</strong>
            <strong>Final Equity</strong>
            {strategies.map((strategy, index) => (
              <React.Fragment key={strategy.name}>
                <span>
                  <i className="perf-dot" style={{ background: strategyPalette[index % strategyPalette.length] }} />
                  {strategy.name}
                </span>
                <span>{strategy.type}</span>
                {strategy.metrics ? (
                  <>
                    <span className={strategy.metrics.returnPercent >= 0 ? "gain" : "loss"}>
                      {strategy.metrics.returnPercent >= 0 ? "+" : ""}
                      {strategy.metrics.returnPercent}%
                    </span>
                    <span>{strategy.metrics.winRate === null ? "--" : `${strategy.metrics.winRate}%`}</span>
                    <span className={strategy.metrics.maxDrawdown < 0 ? "loss" : ""}>{strategy.metrics.maxDrawdown}%</span>
                    <span>{strategy.metrics.tradeCount}</span>
                    <span>{money.format(strategy.metrics.finalEquity)}</span>
                  </>
                ) : (
                  <span className="loss perf-error-row">{strategy.error || "Backtest failed."}</span>
                )}
              </React.Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ProfitBoard({
  scan,
  status,
  range,
  symbols,
  settings,
  onToggleSymbol
}: {
  scan: ScanResult | null;
  status: string;
  range: ChartRange;
  symbols: string[];
  settings: AlgorithmSymbolSettings;
  onToggleSymbol: (strategyId: string, symbol: string) => void;
}) {
  const strategies = scan?.strategies ?? [];
  const tradeTape = collectScanTrades(scan).slice(0, 24);

  return (
    <section className="profit-board">
      <div className="section-title">
        <span>Algorithm Results</span>
        <BarChart3 size={16} />
      </div>
      <div className="perf-status">{status}</div>
      {strategies.length > 0 && (
        <>
          <div className="profit-cards">
            {strategies.map((strategy, index) => (
              <div key={strategy.id} style={{ borderLeftColor: strategyPalette[index % strategyPalette.length] }}>
                <span>{strategy.name}</span>
                <strong className={strategy.totals.pnl >= 0 ? "gain" : "loss"}>
                  {strategy.totals.pnl >= 0 ? "+" : ""}
                  {money.format(strategy.totals.pnl)}
                </strong>
                <small>
                  {strategy.totals.avgReturnPercent >= 0 ? "+" : ""}
                  {strategy.totals.avgReturnPercent}% avg return · {strategy.totals.profitableSymbols}/{strategy.totals.scoredSymbols} profitable
                </small>
                {bestSymbolForStrategy(strategy) && (
                  <em>
                    Best: {bestSymbolForStrategy(strategy)?.symbol} ({bestSymbolForStrategy(strategy)!.returnPercent! >= 0 ? "+" : ""}
                    {bestSymbolForStrategy(strategy)?.returnPercent}%)
                  </em>
                )}
              </div>
            ))}
          </div>
          <div className="section-title signal-board-title">
            <span>Candidate Stocks by Algorithm</span>
          </div>
          <div className="algorithm-candidate-grid">
            {strategies.map((strategy) => (
              <div className="candidate-row" key={strategy.id}>
                <strong>{strategy.name}</strong>
                <div>
                  {symbols.map((symbol) => {
                    const enabled = isSymbolEnabledForAlgorithm(settings, strategy.id, symbol);
                    return (
                      <button className={enabled ? "enabled" : ""} key={`${strategy.id}-${symbol}`} onClick={() => onToggleSymbol(strategy.id, symbol)} type="button">
                        {symbol}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="section-title signal-board-title">
            <span>Algorithm Trade Tape</span>
          </div>
          <div className="algorithm-trade-tape">
            <strong>Time</strong>
            <strong>Symbol</strong>
            <strong>Side</strong>
            <strong>Algorithm</strong>
            <strong>Price</strong>
            <strong>P/L</strong>
            <strong>Return</strong>
            <strong>State</strong>
            {tradeTape.length === 0 ? (
              <span className="empty-row">No algorithm trades in this window.</span>
            ) : (
              tradeTape.map((trade, index) => (
                <React.Fragment key={trade.id}>
                  <span>{displayTime(trade.time, range)}</span>
                  <span>{trade.symbol}</span>
                  <span className={trade.side === "buy" ? "gain" : "loss"}>{trade.side.toUpperCase()}</span>
                  <span>
                    <i className="perf-dot" style={{ background: strategyPalette[index % strategyPalette.length] }} />
                    {trade.strategyName}
                  </span>
                  <span>{priceMoney(trade.price)}</span>
                  <span className={trade.pnl >= 0 ? "gain" : "loss"}>{money.format(trade.pnl)}</span>
                  <span className={trade.returnPercent >= 0 ? "gain" : "loss"}>
                    {trade.returnPercent >= 0 ? "+" : ""}
                    {trade.returnPercent}%
                  </span>
                  <span>{trade.recommendation.toUpperCase()}</span>
                </React.Fragment>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

function AlgorithmTradesRail({
  scan,
  range,
  status,
  selectedStrategyId,
  onSelectStrategy
}: {
  scan: ScanResult | null;
  range: ChartRange;
  status: string;
  selectedStrategyId: string;
  onSelectStrategy: (strategyId: string) => void;
}) {
  const [sortKey, setSortKey] = React.useState<AlgorithmSortKey>("return");
  const strategies = scan?.strategies ?? [];
  const sortedStrategies = sortStrategiesForRail(strategies, sortKey);
  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId) ?? strategies[0] ?? null;
  const trades = selectedStrategy
    ? selectedStrategy.perSymbol.flatMap((entry) =>
        (entry.trades?.length
          ? entry.trades
          : entry.lastAction
            ? [{ ...entry.lastAction, id: `${selectedStrategy.id}-${entry.symbol}-${entry.lastAction.time}`, quantity: 0, pnlPercent: entry.returnPercent ?? 0 }]
            : []
        ).map((trade) => ({
          ...trade,
          symbol: entry.symbol,
          recommendation: entry.recommendation,
          pnl: entry.pnl ?? 0
        }))
      )
    : [];

  return (
    <section className="algorithm-trades-rail">
      <div className="section-title">
        <span>Algorithm Trades</span>
        <Activity size={16} />
      </div>
      <p>{status}</p>
      <label className="rail-sort-control">
        <span>Sort algorithms</span>
        <select value={sortKey} onChange={(event) => setSortKey(event.target.value as AlgorithmSortKey)}>
          <option value="return">Best avg return</option>
          <option value="pnl">Highest P/L</option>
          <option value="trades">Most trades</option>
          <option value="winRate">Best win rate</option>
          <option value="name">Name A-Z</option>
        </select>
      </label>
      <div className="rail-algorithm-list">
        {sortedStrategies.map((strategy) => {
          const best = bestSymbolForStrategy(strategy);
          const winRate = averageWinRateForStrategy(strategy);
          const tradesCount = totalTradesForStrategy(strategy);
          return (
            <button className={selectedStrategy?.id === strategy.id ? "selected" : ""} key={strategy.id} onClick={() => onSelectStrategy(strategy.id)} type="button">
              <strong>{strategy.name}</strong>
              <span>
                {best ? `Best ${best.symbol} ${best.returnPercent! >= 0 ? "+" : ""}${best.returnPercent}%` : "No scored stocks"}
              </span>
              <div className="rail-algorithm-metrics">
                <em className={strategy.totals.avgReturnPercent >= 0 ? "gain" : "loss"}>
                  {strategy.totals.avgReturnPercent >= 0 ? "+" : ""}
                  {strategy.totals.avgReturnPercent}%
                </em>
                <em className={strategy.totals.pnl >= 0 ? "gain" : "loss"}>{money.format(strategy.totals.pnl)}</em>
                <em>{tradesCount} trades</em>
                <em>{winRate === null ? "Win --" : `Win ${winRate}%`}</em>
              </div>
            </button>
          );
        })}
      </div>
      <div className="rail-trade-list">
        {trades.map((trade) => (
          <div className="rail-trade-row" key={trade.id}>
            <div>
              <strong>{trade.symbol}</strong>
              <span>{trade.rule ?? trade.recommendation ?? "algorithm trade"}</span>
            </div>
            <div>
              <strong className={trade.side === "buy" ? "gain" : "loss"}>{trade.side.toUpperCase()}</strong>
              <span>{displayTime(trade.time, range)}</span>
            </div>
          </div>
        ))}
        {selectedStrategy && trades.length === 0 && <span className="empty-state">No buys or sells for {selectedStrategy.name} in this window.</span>}
        {!selectedStrategy && <span className="empty-state">No algorithms available.</span>}
      </div>
    </section>
  );
}

function StatsSheet({ scan, status, range }: { scan: ScanResult | null; status: string; range: ChartRange }) {
  const strategies = scan?.strategies ?? [];

  return (
    <section className="stats-sheet-panel">
      <div className="section-title">
        <span>Strategy Statistics Sheet — {scan?.symbols.join(", ") || "no stocks"} · {range} window</span>
        <Table2 size={16} />
      </div>
      <div className="perf-status">{status}</div>
      <div className="stat-sheet">
        <strong>Strategy</strong>
        <strong>Symbol</strong>
        <strong>Return</strong>
        <strong>P/L $</strong>
        <strong>Win Rate</strong>
        <strong>Max DD</strong>
        <strong>Sharpe</strong>
        <strong>Profit Factor</strong>
        <strong>Exposure</strong>
        <strong>Avg Trade</strong>
        <strong>Trades</strong>
        <strong>Position</strong>
        <strong>Last Action</strong>
        <strong>Signal</strong>
        {strategies.flatMap((strategy, index) =>
          strategy.perSymbol.map((entry) => (
            <React.Fragment key={`${strategy.id}-${entry.symbol}`}>
              <span>
                <i className="perf-dot" style={{ background: strategyPalette[index % strategyPalette.length] }} />
                {strategy.name}
              </span>
              <span>{entry.symbol}</span>
              {entry.error ? (
                <span className="loss stat-error">{entry.error}</span>
              ) : (
                <>
                  <span className={(entry.returnPercent ?? 0) >= 0 ? "gain" : "loss"}>
                    {(entry.returnPercent ?? 0) >= 0 ? "+" : ""}
                    {entry.returnPercent}%
                  </span>
                  <span className={(entry.pnl ?? 0) >= 0 ? "gain" : "loss"}>{money.format(entry.pnl ?? 0)}</span>
                  <span>{entry.winRate === null || entry.winRate === undefined ? "--" : `${entry.winRate}%`}</span>
                  <span className={(entry.maxDrawdown ?? 0) < 0 ? "loss" : ""}>{entry.maxDrawdown}%</span>
                  <span>{entry.sharpe}</span>
                  <span>{entry.profitFactor}</span>
                  <span>{entry.exposurePercent}%</span>
                  <span className={(entry.avgTradePercent ?? 0) >= 0 ? "gain" : "loss"}>
                    {(entry.avgTradePercent ?? 0) >= 0 ? "+" : ""}
                    {entry.avgTradePercent}%
                  </span>
                  <span>{entry.tradeCount}</span>
                  <span>{entry.openPosition ? "Open" : "Flat"}</span>
                  <span>
                    {entry.lastAction
                      ? `${entry.lastAction.side.toUpperCase()} ${displayTime(entry.lastAction.time, range)} @ ${priceMoney(entry.lastAction.price)}`
                      : "--"}
                  </span>
                  <span className={entry.recommendation === "buy" ? "gain" : entry.recommendation === "sell" ? "loss" : ""}>
                    {(entry.recommendation ?? "--").toUpperCase()}
                  </span>
                </>
              )}
            </React.Fragment>
          ))
        )}
      </div>
    </section>
  );
}

function AlgorithmDeepDive({
  compare,
  algorithms,
  sourceCandles,
  selectedAlgorithmId,
  selectedControlId,
  onAlgorithmChange,
  onControlChange,
  range,
  status,
  loading
}: {
  compare: CompareResult | null;
  algorithms: AlgorithmsPayload | null;
  sourceCandles: Candle[];
  selectedAlgorithmId: string;
  selectedControlId: string;
  onAlgorithmChange: (id: string) => void;
  onControlChange: (id: string) => void;
  range: ChartRange;
  status: string;
  loading: boolean;
}) {
  const strategies = compare?.strategies ?? [];
  const primaryStrategies = strategies.filter((strategy) => strategy.type === "primary");
  const controls = strategies.filter((strategy) => strategy.type === "control");
  const selectedAlgorithm = primaryStrategies.find((strategy) => strategy.id === selectedAlgorithmId) ?? primaryStrategies[0] ?? null;
  const selectedControl = controls.find((strategy) => strategy.id === selectedControlId) ?? controls[0] ?? null;
  const algorithmInfo = algorithms?.algorithms.find((algorithm) => algorithm.id === selectedAlgorithm?.id);
  const code = algorithmInfo?.code || "// Algorithm source is unavailable. Restart the API server if this file was just added.";
  const [simulationStatus, setSimulationStatus] = React.useState("watch");
  const [simulationTime, setSimulationTime] = React.useState("");
  const [simulationNotional, setSimulationNotional] = React.useState("10000");
  const metricRows: Array<{ key: keyof CompareMetrics; label: string }> = [
    { key: "returnPercent", label: "Return" },
    { key: "finalEquity", label: "Final Equity" },
    { key: "winRate", label: "Win Rate" },
    { key: "maxDrawdown", label: "Max Drawdown" },
    { key: "sharpe", label: "Sharpe" },
    { key: "profitFactor", label: "Profit Factor" },
    { key: "exposurePercent", label: "Exposure" },
    { key: "avgTradePercent", label: "Avg Trade" },
    { key: "tradeCount", label: "Trades" },
    { key: "openPosition", label: "Position" }
  ];
  const tradeRows = selectedAlgorithm?.trades ?? [];
  const defaultBuyTime = tradeRows.find((trade) => trade.side === "buy")?.time ?? sourceCandles[0]?.time ?? "";
  const simulationCandle = sourceCandles.find((candle) => candle.time === simulationTime) ?? sourceCandles.find((candle) => candle.time === defaultBuyTime) ?? sourceCandles[0];
  const exitCandle = sourceCandles[sourceCandles.length - 1];
  const notional = Math.max(0, Number(simulationNotional) || 0);
  const simulatedQuantity = simulationCandle ? notional / simulationCandle.close : 0;
  const simulatedPnl = simulationCandle && exitCandle ? (exitCandle.close - simulationCandle.close) * simulatedQuantity : 0;
  const simulatedReturn = simulationCandle && exitCandle ? ((exitCandle.close - simulationCandle.close) / simulationCandle.close) * 100 : 0;
  const nearestTrade = simulationCandle ? nearestAlgorithmTrade(tradeRows, simulationCandle.time) : null;

  React.useEffect(() => {
    const selectedTimeExists = sourceCandles.some((candle) => candle.time === simulationTime);
    if (defaultBuyTime && (!simulationTime || !selectedTimeExists)) {
      setSimulationTime(defaultBuyTime);
    }
  }, [defaultBuyTime, simulationTime, sourceCandles]);

  return (
    <section className="algorithm-deep-dive">
      <div className="section-title">
        <span>Trade Simulator — {compare?.symbol ?? "--"} · {range}</span>
        <Table2 size={16} />
      </div>
      <div className="detail-status">
        <span>{loading ? "Loading section data..." : status}</span>
      </div>
      <div className="detail-selector-row">
        <label>
          <span>Algorithm</span>
          <select value={selectedAlgorithm?.id ?? ""} onChange={(event) => onAlgorithmChange(event.target.value)}>
            {primaryStrategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Control group</span>
          <select value={selectedControl?.id ?? ""} onChange={(event) => onControlChange(event.target.value)}>
            {controls.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span>File</span>
          <strong>{algorithmInfo?.file ?? selectedAlgorithm?.source ?? "--"}</strong>
        </div>
        <div>
          <span>Last Signal</span>
          <strong className={selectedAlgorithm?.lastSignal === "buy" ? "gain" : selectedAlgorithm?.lastSignal === "sell" ? "loss" : ""}>
            {(selectedAlgorithm?.lastSignal ?? "none").toUpperCase()}
          </strong>
        </div>
      </div>

      <section className="simulation-panel">
        <div className="simulation-inputs">
          <label>
            <span>Status</span>
            <select value={simulationStatus} onChange={(event) => setSimulationStatus(event.target.value)}>
              <option value="watch">Watch only</option>
              <option value="bought">Bought</option>
              <option value="closed">Closed position</option>
            </select>
          </label>
          <label>
            <span>Buy time</span>
            <select value={simulationCandle?.time ?? ""} onChange={(event) => setSimulationTime(event.target.value)}>
              {sourceCandles.map((candle) => (
                <option key={candle.time} value={candle.time}>
                  {displayTime(candle.time, range)} · {priceMoney(candle.close)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Buy amount</span>
            <input min="0" onChange={(event) => setSimulationNotional(event.target.value)} type="number" value={simulationNotional} />
          </label>
        </div>
        <div className="simulation-results">
          <div>
            <span>Entry</span>
            <strong>{simulationCandle ? priceMoney(simulationCandle.close) : "--"}</strong>
          </div>
          <div>
            <span>Current/Exit</span>
            <strong>{exitCandle ? priceMoney(exitCandle.close) : "--"}</strong>
          </div>
          <div>
            <span>Shares</span>
            <strong>{number.format(simulatedQuantity)}</strong>
          </div>
          <div>
            <span>Sim P/L</span>
            <strong className={simulatedPnl >= 0 ? "gain" : "loss"}>{money.format(simulatedPnl)}</strong>
          </div>
          <div>
            <span>Return</span>
            <strong className={simulatedReturn >= 0 ? "gain" : "loss"}>
              {simulatedReturn >= 0 ? "+" : ""}
              {simulatedReturn.toFixed(2)}%
            </strong>
          </div>
        </div>
        <div className="simulation-readout">
          <strong>Algorithm at selected time</strong>
          <span>
            {nearestTrade
              ? `${nearestTrade.side.toUpperCase()} ${displayTime(nearestTrade.time, range)} @ ${priceMoney(nearestTrade.price)} · ${nearestTrade.rule ?? "strategy rule"}`
              : "No algorithm trade near the selected time."}
          </span>
        </div>
      </section>

      <details className="algorithm-detail-drawer">
        <summary>Open detailed spreadsheet, code, and control comparison</summary>
        <div className="algorithm-detail-layout">
          <section className="detail-block">
            <div className="section-title">
              <span>Metrics vs Control</span>
            </div>
            <div className="metric-compare-grid">
              <strong>Metric</strong>
              <strong>{selectedControl?.name ?? "Control"}</strong>
              <strong>{selectedAlgorithm?.name ?? "Algorithm"}</strong>
              <strong>Delta</strong>
              <strong>Winner</strong>
              {metricRows.map((row) => {
                const winner = metricWinner(row.key, selectedAlgorithm?.metrics ?? null, selectedControl?.metrics ?? null);
                const delta = metricDelta(row.key, selectedAlgorithm?.metrics ?? null, selectedControl?.metrics ?? null);
                return (
                  <React.Fragment key={row.key}>
                    <span>{row.label}</span>
                    <span>{metricValue(row.key, selectedControl?.metrics ?? null)}</span>
                    <span>{metricValue(row.key, selectedAlgorithm?.metrics ?? null)}</span>
                    <span className={delta === "--" ? "" : String(delta).startsWith("-") ? "loss" : "gain"}>{delta}</span>
                    <span className={winner === "Algorithm" ? "gain" : winner === "Control" ? "loss" : ""}>{winner}</span>
                  </React.Fragment>
                );
              })}
            </div>
          </section>

          <section className="detail-block">
            <div className="section-title">
              <span>Algorithm Code</span>
            </div>
            <pre className="code-pane" aria-label={`${selectedAlgorithm?.name ?? "Algorithm"} source code`}>
              {code
                .split("\n")
                .map((line, index) => `${String(index + 1).padStart(3, " ")}  ${line}`)
                .join("\n")}
            </pre>
          </section>
        </div>

        <section className="detail-block">
          <div className="section-title">
            <span>Trade Ledger</span>
          </div>
          <div className="algorithm-trade-sheet">
            <strong>#</strong>
            <strong>Time</strong>
            <strong>Side</strong>
            <strong>Price</strong>
            <strong>Qty</strong>
            <strong>Notional</strong>
            <strong>P/L %</strong>
            <strong>Rule</strong>
            <strong>Control Equity</strong>
            {tradeRows.length === 0 ? (
              <span className="empty-row">No trades generated by this algorithm in the selected window.</span>
            ) : (
              tradeRows.map((trade, index) => {
                const controlPoint = selectedControl?.equityCurve[index] ?? selectedControl?.equityCurve[selectedControl.equityCurve.length - 1];
                return (
                  <React.Fragment key={trade.id}>
                    <span>{index + 1}</span>
                    <span>{displayTime(trade.time, range)}</span>
                    <span className={trade.side === "buy" ? "gain" : "loss"}>{trade.side.toUpperCase()}</span>
                    <span>{priceMoney(trade.price)}</span>
                    <span>{number.format(trade.quantity)}</span>
                    <span>{money.format(trade.price * trade.quantity)}</span>
                    <span className={trade.pnlPercent >= 0 ? "gain" : "loss"}>
                      {trade.pnlPercent >= 0 ? "+" : ""}
                      {trade.pnlPercent}%
                    </span>
                    <span>{trade.rule ?? "--"}</span>
                    <span>{controlPoint ? money.format(controlPoint.equity) : "--"}</span>
                  </React.Fragment>
                );
              })
            )}
          </div>
        </section>

        <section className="detail-block control-code-block">
          <div className="section-title">
            <span>Selected Control Logic</span>
          </div>
          <pre className="code-pane small" aria-label={`${selectedControl?.name ?? "Control"} source code`}>
            {controlCodeSnippet(selectedControl?.id ?? "control/cash")}
          </pre>
        </section>
      </details>
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
  const [realBars, setRealBars] = React.useState<Record<string, BarsEntry>>({});
  const [chartStyle, setChartStyle] = React.useState<ChartStyle>("line");
  const [view, setView] = React.useState<AppView>("stocks");
  const [compare, setCompare] = React.useState<CompareResult | null>(null);
  const [compareStatus, setCompareStatus] = React.useState("Loading strategy comparison...");
  const [compareVersion, setCompareVersion] = React.useState(0);
  const [algorithms, setAlgorithms] = React.useState<AlgorithmsPayload | null>(null);
  const [algorithmStatus, setAlgorithmStatus] = React.useState("");
  const [checkedAlgorithms, setCheckedAlgorithms] = React.useState<string[]>([]);
  const [checklistTouched, setChecklistTouched] = React.useState(false);
  const [homeTab, setHomeTab] = React.useState<HomeTab>("profits");
  const [scan, setScan] = React.useState<ScanResult | null>(null);
  const [scanStatus, setScanStatus] = React.useState("Scanning your open stocks with every algorithm...");
  const [selectedAlgorithmId, setSelectedAlgorithmId] = React.useState("");
  const [selectedControlId, setSelectedControlId] = React.useState("control/spy");
  const [selectedTradeStrategyId, setSelectedTradeStrategyId] = React.useState("");
  const [algorithmSymbols, setAlgorithmSymbols] = React.useState<AlgorithmSymbolSettings>(() => readStoredAlgorithmSymbols());
  const [loadingSections, setLoadingSections] = React.useState<Record<string, boolean>>({});
  const [paramDrafts, setParamDrafts] = React.useState<Record<string, Record<string, string>>>({});
  const algorithmFileInput = React.useRef<HTMLInputElement | null>(null);
  const requestCache = React.useRef(new Map<string, CacheEntry<unknown>>());
  const inflightRequests = React.useRef(new Map<string, Promise<unknown>>());
  const draggedPanel = React.useRef<PanelId | null>(null);

  const selected = assets.find((asset) => asset.symbol === selectedSymbol) ?? assets[0] ?? null;
  const selectedHasRealData = hasRealMarketData(selected);
  const visiblePanels = panelOrder.filter((panelId) => !closedPanels.includes(panelId));
  const activeAssets = activeSymbols.map((symbol) => assets.find((asset) => asset.symbol === symbol)).filter(Boolean) as Asset[];
  const visibleSidebarAssets = query.trim() ? searchResults : assets.slice(0, 12);
  const filteredScan = React.useMemo(() => filterScanResult(scan, algorithmSymbols, activeSymbols), [scan, algorithmSymbols, activeSymbols]);
  const signal = selected && selectedHasRealData ? evaluateStockbotMomentum(selected) : null;
  const baselines = selected && selectedHasRealData ? compareBaselines(selected) : [];
  const chartBarsEntry = selected ? realBars[`${selected.symbol}:${chartRange}`] : undefined;
  const chartCandles = chartBarsEntry?.bars ?? [];
  const compareStrategies = compare?.strategies ?? [];
  const strategyTrades: AlgorithmTrade[] = compareStrategies
    .map((strategy, index) => ({ strategy, color: strategyPalette[index % strategyPalette.length] }))
    .filter(({ strategy }) => strategy.type === "primary" && checkedAlgorithms.includes(strategy.name))
    .flatMap(({ strategy, color }) =>
      (strategy.trades ?? []).map((trade) => ({ ...trade, strategyName: strategy.name, color }))
    )
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const methodScores: StrategyScore[] = compareStrategies
    .filter((strategy) => strategy.metrics)
    .map((strategy) => ({
      name: strategy.name,
      type: strategy.type,
      returnPercent: strategy.metrics!.returnPercent,
      maxDrawdown: strategy.metrics!.maxDrawdown,
      winRate: strategy.metrics!.winRate ?? 0,
      sharpe: strategy.metrics!.sharpe,
      profitFactor: strategy.metrics!.profitFactor,
      trades: strategy.metrics!.tradeCount,
      exposurePercent: strategy.metrics!.exposurePercent,
      avgTradePercent: strategy.metrics!.avgTradePercent
    }));
  const selectedSavedCandles = selected ? savedCandles.filter((saved) => saved.symbol === selected.symbol) : [];

  React.useEffect(() => {
    window.localStorage.setItem("stockbot.algorithmSymbols", JSON.stringify(algorithmSymbols));
  }, [algorithmSymbols]);

  function setSectionLoading(section: string, loading: boolean) {
    setLoadingSections((current) => {
      if (current[section] === loading) {
        return current;
      }
      return { ...current, [section]: loading };
    });
  }

  async function cachedJson<T>(url: string, ttl: number, options?: { force?: boolean }) {
    const cached = requestCache.current.get(url) as CacheEntry<T> | undefined;
    if (!options?.force && cached && Date.now() - cached.at < ttl) {
      return cached.data;
    }
    const existing = inflightRequests.current.get(url) as Promise<T> | undefined;
    if (existing && !options?.force) {
      return existing;
    }
    const request = fetch(url)
      .then(async (response) => {
        const text = await response.text();
        let payload: { error?: string };
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error(
            `API returned an unexpected response (${response.status}). The API server is likely outdated — stop it and run npm run dev again.`
          );
        }
        if (!response.ok) {
          throw new Error(payload.error || `Request failed: ${response.status}`);
        }
        requestCache.current.set(url, { at: Date.now(), data: payload });
        return payload as T;
      })
      .finally(() => {
        inflightRequests.current.delete(url);
      });
    inflightRequests.current.set(url, request);
    return request;
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
    if (closedPanels.includes("portfolio") && view !== "home") {
      return;
    }
    const payload = await cachedJson<{ data: Portfolio }>("/api/portfolio", cacheTtl.portfolio);
    setPortfolio(payload.data);
  }, [closedPanels, view]);

  React.useEffect(() => {
    loadMarket().catch(() => setNotice("Unable to reach Stockbot API"));
    const timer = window.setInterval(() => {
      loadMarket().catch(() => setNotice("Market refresh failed"));
    }, 2500);
    return () => window.clearInterval(timer);
  }, [loadMarket]);

  const loadBars = React.useCallback(async (symbol: string, range: ChartRange, force = false) => {
    const key = `${symbol}:${range}`;
    setSectionLoading(`bars:${key}`, true);
    try {
      const payload = await cachedJson<{ data: { source: string; bars: Candle[] } }>(
        `/api/market/bars/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}`,
        cacheTtl.bars,
        { force }
      );
      setRealBars((current) => ({ ...current, [key]: { source: payload.data.source, bars: payload.data.bars } }));
    } catch (error) {
      setRealBars((current) => ({
        ...current,
        [key]: { source: "unavailable", bars: [], error: error instanceof Error ? error.message : "Historical bars unavailable." }
      }));
    } finally {
      setSectionLoading(`bars:${key}`, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const symbol = selected?.symbol;
    if (!symbol) {
      return;
    }
    loadBars(symbol, chartRange);
    const timer = window.setInterval(() => loadBars(symbol, chartRange, true), 60000);
    return () => window.clearInterval(timer);
  }, [selected?.symbol, chartRange, loadBars]);

  React.useEffect(() => {
    const symbol = selected?.symbol;
    if (!symbol) {
      return;
    }
    let cancelled = false;
    setSectionLoading("compare", true);
    setCompareStatus("Running strategy backtests on real bars...");
    cachedJson<{ data: CompareResult }>(`/api/compare/${encodeURIComponent(symbol)}?range=${encodeURIComponent(chartRange)}`, cacheTtl.compare)
      .then((payload) => {
        if (!cancelled) {
          setCompare(payload.data);
          setCompareStatus(`All strategies backtested on the same ${chartRange} window of ${payload.data.source} bars. Click a strategy to show or hide it.`);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setCompare(null);
          setCompareStatus(error instanceof Error ? error.message : "Strategy comparison unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSectionLoading("compare", false);
        }
      });
    return () => {
      cancelled = true;
      setSectionLoading("compare", false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.symbol, chartRange, compareVersion]);

  React.useEffect(() => {
    if (checklistTouched || checkedAlgorithms.length > 0) {
      return;
    }
    const firstPrimary = compare?.strategies.find((strategy) => strategy.type === "primary" && !strategy.error);
    if (firstPrimary) {
      setCheckedAlgorithms([firstPrimary.name]);
      setSelectedAlgorithmId((current) => current || firstPrimary.id);
    }
  }, [compare, checkedAlgorithms.length, checklistTouched]);

  React.useEffect(() => {
    if (!compare) {
      return;
    }
    const firstPrimary = compare?.strategies.find((strategy) => strategy.type === "primary" && !strategy.error);
    const firstControl = compare?.strategies.find((strategy) => strategy.type === "control");
    if (firstPrimary && !compare.strategies.some((strategy) => strategy.id === selectedAlgorithmId)) {
      setSelectedAlgorithmId(firstPrimary.id);
    }
    if (firstControl && !compare.strategies.some((strategy) => strategy.id === selectedControlId)) {
      setSelectedControlId(firstControl.id);
    }
  }, [compare, selectedAlgorithmId, selectedControlId]);

  React.useEffect(() => {
    if (view !== "home") {
      return;
    }
    const symbolList = activeSymbols.join(",");
    let cancelled = false;
    setSectionLoading("scan", true);
    setScanStatus(`Scanning ${activeSymbols.length} candidate stocks for each algorithm...`);
    cachedJson<{ data: ScanResult }>(
      `/api/algorithms/scan?symbols=${encodeURIComponent(symbolList)}&range=${encodeURIComponent(chartRange)}`,
      cacheTtl.compare
    )
      .then((payload) => {
        if (!cancelled) {
          setScan(payload.data);
          setScanStatus(
            `Each algorithm backtested its enabled candidates from ${payload.data.symbols.length} available stocks on the same ${payload.data.range} window.`
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setScan(null);
          setScanStatus(error instanceof Error ? error.message : "Scan unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSectionLoading("scan", false);
        }
      });
    return () => {
      cancelled = true;
      setSectionLoading("scan", false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, activeSymbols, chartRange, compareVersion]);

  React.useEffect(() => {
    const firstStrategy = filteredScan?.strategies[0];
    if (firstStrategy && !filteredScan?.strategies.some((strategy) => strategy.id === selectedTradeStrategyId)) {
      setSelectedTradeStrategyId(firstStrategy.id);
    }
  }, [filteredScan, selectedTradeStrategyId]);

  function toggleAlgorithm(name: string) {
    setChecklistTouched(true);
    setCheckedAlgorithms((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  }

  function toggleAlgorithmSymbol(strategyId: string, symbol: string) {
    setAlgorithmSymbols((current) => ({
      ...current,
      [strategyId]: {
        ...current[strategyId],
        [symbol]: !isSymbolEnabledForAlgorithm(current, strategyId, symbol)
      }
    }));
  }

  function addSymbolToAlgorithmTests(symbol: string) {
    const normalized = symbol.toUpperCase();
    setActiveSymbols((current) => (current.includes(normalized) ? current : [...current, normalized]));
    setSelectedSymbol(normalized);
    setNotice(`${normalized} added to algorithm tests.`);
  }

  async function saveAlgorithmParams(algorithm: AlgorithmInfo) {
    const draft = paramDrafts[algorithm.id] ?? {};
    setAlgorithmStatus(`Saving parameters for ${algorithm.name}...`);
    try {
      const response = await fetch("/api/algorithms/params", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: algorithm.id, params: { ...algorithm.params, ...draft } })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Save failed: ${response.status}`);
      }
      setAlgorithms(payload.data ?? null);
      setParamDrafts((current) => ({ ...current, [algorithm.id]: {} }));
      setAlgorithmStatus(`${algorithm.name} parameters saved. Backtests refreshed.`);
      requestCache.current.clear();
      inflightRequests.current.clear();
      setCompareVersion((current) => current + 1);
    } catch (error) {
      setAlgorithmStatus(error instanceof Error ? error.message : "Parameter save failed.");
    }
  }

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/algorithms")
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) {
          setAlgorithms(payload.data ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAlgorithmStatus("Could not load the algorithm library. Is the API server up to date?");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, compareVersion]);

  async function uploadAlgorithm(file: File) {
    setAlgorithmStatus(`Uploading ${file.name}...`);
    try {
      const code = await file.text();
      const response = await fetch("/api/algorithms/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, code })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `Upload failed: ${response.status}`);
      }
      setAlgorithms(payload.data ?? null);
      setAlgorithmStatus(`${file.name} installed. Backtests refreshed.`);
      requestCache.current.clear();
      inflightRequests.current.clear();
      setCompareVersion((current) => current + 1);
    } catch (error) {
      setAlgorithmStatus(error instanceof Error ? error.message : "Upload failed.");
    }
  }

  React.useEffect(() => {
    for (const symbol of activeSymbols) {
      loadBars(symbol, "1D");
    }
    const timer = window.setInterval(() => {
      for (const symbol of activeSymbols) {
        loadBars(symbol, "1D", true);
      }
    }, 120000);
    return () => window.clearInterval(timer);
  }, [activeSymbols, loadBars]);

  React.useEffect(() => {
    loadPortfolio().catch(() => setNotice("Portfolio refresh failed"));
    const timer = window.setInterval(() => {
      loadPortfolio().catch(() => setNotice("Portfolio refresh failed"));
    }, 6000);
    return () => window.clearInterval(timer);
  }, [loadPortfolio]);

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
    inflightRequests.current.clear();
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
    const strategyName = checkedAlgorithms[0] ?? "Manual";
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
            <RangeControls
              chartStyle={chartStyle}
              range={chartRange}
              zoom={zoom}
              onChartStyleChange={setChartStyle}
              onRangeChange={changeChartRange}
              onZoomChange={setZoom}
              onExpand={() => setFocusedChartOpen(true)}
            />
          </div>
          {hasRealMarketData(selected) ? (
            <>
              <OverlayControls overlays={overlays} setOverlays={setOverlays} />
              {chartCandles.length > 0 ? (
                <CandlestickChart asset={selected} chartStyle={chartStyle} sourceCandles={chartCandles} onSaveCandle={saveCandle} overlays={overlays} range={chartRange} trades={strategyTrades} zoom={zoom} />
              ) : (
                <div className="chart-placeholder" role="status">
                  {chartBarsEntry?.error ? (
                    <>
                      <strong>Historical bars unavailable for {selected.symbol}</strong>
                      <span>{chartBarsEntry.error}</span>
                    </>
                  ) : (
                    <span>Loading real {chartRange} bars for {selected.symbol}...</span>
                  )}
                </div>
              )}
              <RangeReadout asset={selected} sourceCandles={chartCandles} range={chartRange} zoom={zoom} />
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
                  <span>Quote source</span>
                  <strong>{selected.dataSource || "Configured provider"}</strong>
                </div>
                <div>
                  <span>Bars source</span>
                  <strong>{chartBarsEntry?.source ?? "Loading"}</strong>
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
              <DiagnosticSheet asset={selected} sourceCandles={chartCandles} />
              <TradeTraceSheet range={chartRange} trades={strategyTrades} />
            </div>
          ) : (
            <CandleCalculationSheet
              asset={selected}
              sourceCandles={chartCandles}
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
                  <MiniCandles asset={asset} sourceCandles={realBars[`${asset.symbol}:1D`]?.bars ?? []} />
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
            <span>Algorithms on Chart</span>
            <Activity size={16} />
          </div>
          <AlgorithmChecklist checked={checkedAlgorithms} onToggle={toggleAlgorithm} range={chartRange} strategies={compareStrategies} />
          {signal && selected && hasRealMarketData(selected) && (
            <div className="signal-card">
              <span>Quote momentum read</span>
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

    return <MethodBoard strategies={methodScores} />;
  }

  return (
    <main className="app-shell">
      <aside className={`sidebar ${view === "home" ? "algorithm-sidebar" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark">
            <LineChart size={21} />
          </div>
          <div>
            <strong>Stockbot</strong>
            <span>Algorithm monitor</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Dashboard views">
          <button className={view === "stocks" ? "selected" : ""} onClick={() => setView("stocks")} type="button">
            <BarChart3 size={16} />
            <span>Stock Dashboard</span>
          </button>
          <button className={view === "home" ? "selected" : ""} onClick={() => setView("home")} type="button">
            <Home size={16} />
            <span>My Algorithms</span>
          </button>
        </nav>

        {view === "stocks" ? (
          <>
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
                <div className={`asset-row ${selected?.symbol === asset.symbol ? "active" : ""}`} key={asset.symbol}>
                  <button className="asset-main" onClick={() => openSearchResult(asset)} type="button">
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
                  <button className={activeSymbols.includes(asset.symbol) ? "asset-add added" : "asset-add"} onClick={() => addSymbolToAlgorithmTests(asset.symbol)} type="button">
                    {activeSymbols.includes(asset.symbol) ? "Testing" : "Test"}
                  </button>
                </div>
              ))}
              {query.trim() && visibleSidebarAssets.length === 0 && <p className="empty-state">No matches. Try company name, sector, or nickname.</p>}
            </section>
          </>
        ) : (
          <div className="algorithm-sidebar-content">
            <div className="algorithm-rail-summary">
              <span>Active analysis</span>
              <strong>{filteredScan?.strategies.length ?? 0} algorithms</strong>
              <small>{activeSymbols.length} candidates · {chartRange} window</small>
            </div>
            <AlgorithmTradesRail
              range={chartRange}
              scan={filteredScan}
              selectedStrategyId={selectedTradeStrategyId}
              status={loadingSections.scan ? "Loading algorithm trades..." : scanStatus}
              onSelectStrategy={setSelectedTradeStrategyId}
            />
          </div>
        )}
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">{view === "home" ? "Auto-Trading Home" : "Live Strategy Cockpit"}</p>
            <h1>
              {view === "home"
                ? portfolio
                  ? `Equity ${money.format(portfolio.equity)}`
                  : "Loading portfolio"
                : selected
                  ? `${selected.symbol} ${assetPriceLabel(selected)}`
                  : "Loading market"}
            </h1>
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

        {view === "stocks" ? (
          <>
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
          </>
        ) : (
          <section className="home-dashboard">
            <div className="algorithm-workspace-header">
              <div>
                <span>Analysis workspace</span>
                <strong>Profits, signals, and model simulation</strong>
              </div>
              <div className="algorithm-view-switch" aria-label="My Algorithms views">
              <button className={homeTab === "profits" ? "selected" : ""} onClick={() => setHomeTab("profits")} type="button">
                Profits &amp; Signals
              </button>
                <button className={homeTab === "detail" ? "selected" : ""} onClick={() => setHomeTab("detail")} type="button">
                  Simulator
                </button>
              <button className={homeTab === "stats" ? "selected" : ""} onClick={() => setHomeTab("stats")} type="button">
                  Detail Sheet
              </button>
              </div>
            </div>
            {homeTab === "profits" && portfolio && (
              <div className="home-summary">
                <div>
                  <span>Total equity</span>
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
                <div>
                  <span>Unrealized P/L</span>
                  <strong className={portfolio.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0) >= 0 ? "gain" : "loss"}>
                    {money.format(portfolio.positions.reduce((sum, position) => sum + position.unrealizedPnl, 0))}
                  </strong>
                </div>
                <div>
                  <span>Open positions</span>
                  <strong>{portfolio.positions.length}</strong>
                </div>
              </div>
            )}
            <div className="home-controls">
              <label>
                <span>Analysis symbol</span>
                <select value={selected?.symbol ?? ""} onChange={(event) => openTab(event.target.value)}>
                  {activeSymbols.map((symbol) => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Timeframe</span>
                <select value={chartRange} onChange={(event) => changeChartRange(event.target.value as ChartRange)}>
                  {chartRanges.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label} · {option.resolution}
                    </option>
                  ))}
                </select>
              </label>
              <span>Candidate set: {activeSymbols.join(", ")}.</span>
            </div>
            {homeTab === "detail" ? (
              <AlgorithmDeepDive
                algorithms={algorithms}
                compare={compare}
                loading={Boolean(loadingSections.compare)}
                range={chartRange}
                selectedAlgorithmId={selectedAlgorithmId}
                selectedControlId={selectedControlId}
                sourceCandles={chartCandles}
                status={compareStatus}
                onAlgorithmChange={setSelectedAlgorithmId}
                onControlChange={setSelectedControlId}
              />
            ) : homeTab === "profits" ? (
              <>
                <ProfitBoard
                  range={chartRange}
                  scan={filteredScan}
                  settings={algorithmSymbols}
                  status={loadingSections.scan ? "Loading scan data..." : scanStatus}
                  symbols={activeSymbols}
                  onToggleSymbol={toggleAlgorithmSymbol}
                />
                {selected && <PerformancePanel compare={compare} range={chartRange} status={loadingSections.compare ? "Updating comparison..." : compareStatus} symbol={selected.symbol} />}
              </>
            ) : (
              <StatsSheet range={chartRange} scan={filteredScan} status={loadingSections.scan ? "Loading scan data..." : scanStatus} />
            )}
            <details className="algorithm-library">
              <summary>
                <span>Algorithm Library &amp; Parameters</span>
                <SlidersHorizontal size={16} />
              </summary>
              <div className="section-title library-title-hidden">
                <span>Algorithm Library</span>
                <SlidersHorizontal size={16} />
              </div>
              <p className="library-note">
                Every .js file in the <code>algorithms/</code> folder is backtested above against the S&amp;P 500 and Cash controls. Write your own
                using the format in <code>algorithms/README.md</code>, drop it in the folder, or upload it here.
              </p>
              <div className="library-actions">
                <button className="primary-action" onClick={() => algorithmFileInput.current?.click()} type="button">
                  Upload algorithm (.js)
                </button>
                <input
                  accept=".js"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      uploadAlgorithm(file);
                    }
                    event.target.value = "";
                  }}
                  ref={algorithmFileInput}
                  type="file"
                />
                {algorithmStatus && <span className="library-status">{algorithmStatus}</span>}
              </div>
              <div className="library-grid">
                <strong>Algorithm</strong>
                <strong>Author</strong>
                <strong>Description</strong>
                <strong>Parameters (editable)</strong>
                <strong>File</strong>
                {(algorithms?.algorithms ?? []).map((algorithm) => (
                  <React.Fragment key={algorithm.id}>
                    <span>{algorithm.name}</span>
                    <span>{algorithm.author || "--"}</span>
                    <span>{algorithm.description || "--"}</span>
                    <span className="param-cell">
                      {Object.keys(algorithm.params ?? {}).length === 0 ? (
                        "--"
                      ) : (
                        <>
                          {Object.entries(algorithm.params ?? {}).map(([key, value]) => (
                            <label key={key}>
                              <span>{key}</span>
                              <input
                                onChange={(event) =>
                                  setParamDrafts((current) => ({
                                    ...current,
                                    [algorithm.id]: { ...current[algorithm.id], [key]: event.target.value }
                                  }))
                                }
                                value={paramDrafts[algorithm.id]?.[key] ?? String(value)}
                              />
                            </label>
                          ))}
                          <button className="secondary-action" onClick={() => saveAlgorithmParams(algorithm)} type="button">
                            Save
                          </button>
                        </>
                      )}
                    </span>
                    <span>
                      {algorithm.file}
                      {algorithm.uploaded ? " (uploaded)" : ""}
                    </span>
                  </React.Fragment>
                ))}
                {algorithms && algorithms.algorithms.length === 0 && (
                  <span className="empty-row">No algorithms installed. Add .js files to the algorithms folder.</span>
                )}
              </div>
              {(algorithms?.errors ?? []).map((loadError) => (
                <p className="library-error" key={loadError.file}>
                  <ShieldAlert size={14} /> {loadError.file}: {loadError.error}
                </p>
              ))}
            </details>
          </section>
        )}
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
                  chartStyle={chartStyle}
                  range={chartRange}
                  zoom={zoom}
                  onChartStyleChange={setChartStyle}
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
            {chartCandles.length > 0 ? (
              <CandlestickChart asset={selected} chartStyle={chartStyle} expanded sourceCandles={chartCandles} onSaveCandle={saveCandle} overlays={overlays} range={chartRange} trades={strategyTrades} zoom={zoom} />
            ) : (
              <div className="chart-placeholder" role="status">
                <span>Loading real {chartRange} bars for {selected.symbol}...</span>
              </div>
            )}
            <RangeReadout asset={selected} sourceCandles={chartCandles} range={chartRange} zoom={zoom} />
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
