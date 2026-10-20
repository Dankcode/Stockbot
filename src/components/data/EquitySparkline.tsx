import * as React from "react";
import type { EquityPoint } from "../../lib/types";

export function EquitySparkline({ points, label = "Equity history" }: { points: EquityPoint[]; label?: string }) {
  const path = React.useMemo(() => {
    if (points.length < 2) return "";
    let min = points[0].equity;
    let max = points[0].equity;
    for (const point of points) {
      if (point.equity < min) min = point.equity;
      if (point.equity > max) max = point.equity;
    }
    const spread = Math.max(1, max - min);
    return points
      .map((point, index) => {
        const x = (index / (points.length - 1)) * 100;
        const y = 34 - ((point.equity - min) / spread) * 30;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [points]);

  if (!path) return null;
  return (
    <svg className="equity-sparkline" viewBox="0 0 100 38" preserveAspectRatio="none" role="img" aria-label={label}>
      <path className="spark-grid" d="M0 10H100 M0 24H100" />
      <path className="spark-line" d={path} />
    </svg>
  );
}
