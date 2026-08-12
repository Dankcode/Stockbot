export type ChartTime = string | number;

export type ChartBar = {
  time: ChartTime;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type ChartTrade = {
  id: string;
  time: ChartTime;
  side: "buy" | "sell";
  price?: number;
  quantity?: number;
  label?: string;
  reason?: string;
};

export type ChartRiskEvent = {
  id: string;
  time: ChartTime;
  label: string;
  severity?: "info" | "warn" | "block" | "halt";
  price?: number;
};

export type ChartEquityPoint = {
  time: ChartTime;
  equity: number;
};

export type ChartEquitySeries = {
  id: string;
  label: string;
  points: readonly ChartEquityPoint[];
  kind?: "strategy" | "control" | "cash";
  visible?: boolean;
};

/** End index is exclusive, matching Array.prototype.slice. */
export type ChartViewport = {
  startIndex: number;
  endIndex: number;
};

export type ChartHover = {
  bar: ChartBar | null;
  barIndex: number | null;
  time: ChartTime | null;
  price: number | null;
  equity: Readonly<Record<string, number>>;
};

export type MarketChartProps = {
  bars: readonly ChartBar[];
  trades?: readonly ChartTrade[];
  riskEvents?: readonly ChartRiskEvent[];
  equitySeries?: readonly ChartEquitySeries[];
  range?: string;
  interval?: string;
  height?: number;
  className?: string;
  ariaLabel?: string;
  viewport?: ChartViewport;
  defaultViewport?: ChartViewport;
  initialVisibleBars?: number;
  onViewportChange?: (viewport: ChartViewport) => void;
  replayIndex?: number;
  showVolume?: boolean;
  movingAverage?: number | false;
  showVwap?: boolean;
  showBands?: boolean;
  logScale?: boolean;
  defaultLogScale?: boolean;
  onLogScaleChange?: (enabled: boolean) => void;
  minBarWidth?: number;
  canvasThreshold?: number;
  onBarSelect?: (bar: ChartBar, index: number) => void;
  onHoverChange?: (hover: ChartHover | null) => void;
};

export type ReplaySpeed = 1 | 2 | 10;

export type SessionReplayProps = {
  times: readonly ChartTime[];
  index: number;
  onIndexChange: (index: number) => void;
  speed?: ReplaySpeed;
  onSpeedChange?: (speed: ReplaySpeed) => void;
  playing?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  loop?: boolean;
  ariaLabel?: string;
  className?: string;
};

