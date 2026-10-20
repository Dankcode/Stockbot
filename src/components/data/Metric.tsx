import { ArrowDown, ArrowUp } from "lucide-react";
import { formatMetric } from "../../../packages/shared/format.js";
import { getMetricDefinition, type MetricKey } from "../../../packages/shared/metrics.js";

type MetricProps = {
  metric: MetricKey;
  value: number | null | undefined;
  label?: string;
  delta?: number | null;
  compact?: boolean;
};

export function Metric({ metric, value, label, delta, compact = false }: MetricProps) {
  const definition = getMetricDefinition(metric);
  const direction = value === null || value === undefined || value === 0
    ? "neutral"
    : definition.signConvention === "positive-magnitude"
      ? "negative"
      : definition.signConvention === "signed"
        ? value > 0 ? "positive" : "negative"
        : "neutral";
  return (
    <div className={`metric${compact ? " compact" : ""}`}>
      <span className="metric-label">{label ?? definition.label}</span>
      <strong className={`metric-value ${direction}`}>{formatMetric(metric, value)}</strong>
      {delta !== null && delta !== undefined ? (
        <span className={`metric-delta ${delta >= 0 ? "positive" : "negative"}`}>
          {delta >= 0 ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
          {formatMetric(metric, Math.abs(delta))}
        </span>
      ) : null}
    </div>
  );
}
