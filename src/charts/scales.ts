export type ChartLayout = {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotTop: number;
  plotBottom: number;
  plotWidth: number;
  plotHeight: number;
  volumeTop: number;
  volumeHeight: number;
  axisBottom: number;
};

export type NumericScale = {
  minimum: number;
  maximum: number;
  log: boolean;
  project: (value: number) => number;
  invert: (pixel: number) => number;
  ticks: readonly number[];
};

export function createChartLayout(width: number, height: number, showVolume: boolean): ChartLayout {
  const safeWidth = Math.max(280, width);
  const safeHeight = Math.max(280, height);
  const plotLeft = 12;
  const plotRight = safeWidth - 70;
  const plotTop = 16;
  const axisBottom = safeHeight - 30;
  const volumeHeight = showVolume ? Math.min(62, Math.max(36, safeHeight * 0.15)) : 0;
  const volumeGap = showVolume ? 10 : 0;
  const plotBottom = axisBottom - volumeHeight - volumeGap;
  return {
    width: safeWidth,
    height: safeHeight,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth: Math.max(1, plotRight - plotLeft),
    plotHeight: Math.max(1, plotBottom - plotTop),
    volumeTop: plotBottom + volumeGap,
    volumeHeight,
    axisBottom
  };
}

function paddedDomain(minimum: number, maximum: number, log: boolean) {
  if (log && minimum > 0 && maximum > 0) {
    const logMinimum = Math.log(minimum);
    const logMaximum = Math.log(maximum);
    const padding = Math.max(0.008, (logMaximum - logMinimum) * 0.06);
    return { minimum: Math.exp(logMinimum - padding), maximum: Math.exp(logMaximum + padding) };
  }
  const span = maximum - minimum || Math.max(Math.abs(maximum), 1) * 0.02;
  const padding = span * 0.06;
  return { minimum: minimum - padding, maximum: maximum + padding };
}

export function createNumericScale(
  rawMinimum: number,
  rawMaximum: number,
  top: number,
  bottom: number,
  requestLog = false,
  tickCount = 5
): NumericScale {
  const log = requestLog && rawMinimum > 0 && rawMaximum > 0;
  const domain = paddedDomain(rawMinimum, rawMaximum, log);
  const pixelSpan = Math.max(1, bottom - top);
  const minimumValue = log ? Math.log(domain.minimum) : domain.minimum;
  const maximumValue = log ? Math.log(domain.maximum) : domain.maximum;
  const valueSpan = maximumValue - minimumValue || 1;
  const project = (value: number) => {
    const scaled = log ? Math.log(Math.max(value, domain.minimum)) : value;
    return top + pixelSpan - ((scaled - minimumValue) / valueSpan) * pixelSpan;
  };
  const invert = (pixel: number) => {
    const scaled = minimumValue + ((bottom - pixel) / pixelSpan) * valueSpan;
    return log ? Math.exp(scaled) : scaled;
  };
  const ticks = Array.from({ length: Math.max(2, tickCount) }, (_, index) => {
    const ratio = index / (Math.max(2, tickCount) - 1);
    const scaled = maximumValue - ratio * valueSpan;
    return log ? Math.exp(scaled) : scaled;
  });
  return { minimum: domain.minimum, maximum: domain.maximum, log, project, invert, ticks };
}

export function xForIndex(index: number, count: number, layout: ChartLayout) {
  if (count <= 1) {
    return layout.plotLeft + layout.plotWidth / 2;
  }
  return layout.plotLeft + ((index + 0.5) / count) * layout.plotWidth;
}

export function formatPrice(value: number) {
  const absolute = Math.abs(value);
  const digits = absolute < 1 ? 4 : absolute < 10 ? 3 : 2;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

export function formatEquityMultiple(value: number) {
  return `${value.toFixed(3)}×`;
}

