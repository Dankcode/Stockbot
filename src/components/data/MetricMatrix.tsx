import { compareMetricValues, METRIC_DEFINITIONS, type MetricKey } from "../../../packages/shared/metrics.js";
import { formatMetric } from "../../../packages/shared/format.js";
import type { Metrics } from "../../../packages/shared/schemas.js";
import type { SessionSummary } from "../../lib/types";

const matrixMetrics: Array<MetricKey & keyof Metrics> = ["returnPercent", "maxDrawdown", "sharpe", "winRate", "tradeCount", "exposurePercent"];

export function MetricMatrix({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table metric-matrix" aria-label="Session metric comparison">
        <thead>
          <tr>
            <th>Metric</th>
            {sessions.map((session) => <th className="numeric" key={session.id}>{session.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {matrixMetrics.map((key) => {
            const values = sessions.map((session) => session.metrics?.[key] as number | null | undefined);
            return (
              <tr key={key}>
                <th>{METRIC_DEFINITIONS[key].label}</th>
                {values.map((value, index) => {
                  const directional = METRIC_DEFINITIONS[key].higherIsBetter !== null;
                  const wins = directional && values.every((other, otherIndex) => otherIndex === index || compareMetricValues(key, value, other) !== -1);
                  return <td className={`numeric${wins && value != null ? " winner" : ""}`} key={sessions[index].id}>{formatMetric(key, value)}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
