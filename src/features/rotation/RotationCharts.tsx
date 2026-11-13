import * as React from "react";

type Series = { values: (number | null)[]; className: string; dot?: boolean };

function niceTicks(low: number, high: number, count = 4) {
  const span = high - low || 1;
  const magnitude = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((candidate) => span / candidate <= count) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step) * step; value <= high + 1e-9; value += step) ticks.push(value);
  return ticks;
}

function useWidth<T extends HTMLElement>() {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(640);
  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.round(entry.contentRect.width))));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function LineChart({ series, times, height = 200, format, bands, zero = false, area = false, label }: {
  series: Series[];
  times: number[];
  height?: number;
  format: (value: number) => string;
  bands?: (boolean | null)[];
  zero?: boolean;
  area?: boolean;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const margin = { left: 48, right: 12, top: 10, bottom: 22 };
  const count = times.length;
  const measured = series.flatMap((item) => item.values).filter((value): value is number => value !== null && Number.isFinite(value));
  if (count < 2 || measured.length === 0) return <div ref={ref} className="rl-chart" style={{ height }} />;
  let low = Math.min(...measured);
  let high = Math.max(...measured);
  if (zero) { low = Math.min(low, 0); high = Math.max(high, 0); }
  const pad = (high - low) * 0.06 || 1;
  low -= pad; high += pad;
  const x = (index: number) => margin.left + (index / (count - 1)) * (width - margin.left - margin.right);
  const y = (value: number) => height - margin.bottom - ((value - low) / (high - low)) * (height - margin.top - margin.bottom);
  const path = (values: (number | null)[]) => {
    let drawing = false;
    return values.map((value, index) => {
      if (value === null || !Number.isFinite(value)) { drawing = false; return ""; }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    }).join("");
  };
  const bandRects: React.ReactNode[] = [];
  if (bands) {
    let start = 0;
    for (let index = 1; index <= count; index += 1) {
      if (index === count || bands[index] !== bands[start]) {
        if (bands[start] !== null) {
          bandRects.push(<rect key={start} x={x(start)} y={margin.top} width={Math.max(1, x(index - 1) - x(start))} height={height - margin.top - margin.bottom} className={`rl-band ${bands[start] ? "on" : "off"}`} />);
        }
        start = index;
      }
    }
  }
  const step = Math.max(1, Math.floor(count / 6));
  const dates = Array.from({ length: Math.ceil(count / step) }, (_, slot) => slot * step);
  const last = series.map((item) => {
    for (let index = item.values.length - 1; index >= 0; index -= 1) {
      const value = item.values[index];
      if (value !== null && Number.isFinite(value)) return { index, value, item };
    }
    return null;
  });
  return (
    <div ref={ref} className="rl-chart" style={{ height }}>
      <svg width={width} height={height} role="img" aria-label={label}>
        {bandRects}
        {niceTicks(low, high).map((tick) => (
          <g key={tick}>
            <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} className="rl-tick" />
            <text x={margin.left - 8} y={y(tick) + 3} className="rl-axis" textAnchor="end">{format(tick)}</text>
          </g>
        ))}
        <line x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} className="rl-baseline" />
        {dates.map((index) => (
          <text key={index} x={x(index)} y={height - 6} className="rl-axis" textAnchor={index === 0 ? "start" : "middle"}>
            {new Date(times[index]).toISOString().slice(0, 7)}
          </text>
        ))}
        {area && series[0] ? <path d={`${path(series[0].values)}L${x(count - 1)} ${y(0)}L${x(0)} ${y(0)}Z`} className="rl-area" /> : null}
        {series.map((item) => <path key={item.className} d={path(item.values)} className={`rl-line ${item.className}`} />)}
        {last.map((point) => point && point.item.dot ? <circle key={point.item.className} cx={x(point.index)} cy={y(point.value)} r={2.6} className="rl-dot" /> : null)}
      </svg>
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="rl-spark-empty">—</span>;
  const width = 72;
  const height = 18;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const d = values.map((value, index) => `${index ? "L" : "M"}${(0.5 + (index / (values.length - 1)) * (width - 1)).toFixed(1)} ${(height - 1 - ((value - low) / (high - low || 1)) * (height - 2)).toFixed(1)}`).join("");
  return (
    <svg className="rl-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} className={values[values.length - 1] < 1 ? "down" : undefined} />
    </svg>
  );
}
