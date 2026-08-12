import { ArrowLeft } from "lucide-react";
import * as React from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ChartEquitySeries } from "../../charts";
import { MetricMatrix } from "../../components/data/MetricMatrix";
import { EmptyState, ErrorState, LoadingState } from "../../components/states/DataStates";
import { useQuery } from "../../lib/query";
import { ConfigDiff } from "./ConfigDiff";
import { SessionChartPanel } from "./SessionChartPanel";
import { fetchComparison } from "./sessionData";

function comparisonSeries(entries: Awaited<ReturnType<typeof fetchComparison>>["sessions"]): ChartEquitySeries[] {
  return entries.flatMap((entry) => {
    if (!entry.normalizedEquity.length) return [];
    return [{
      id: entry.session.id,
      label: entry.session.name,
      kind: "strategy" as const,
      points: entry.normalizedEquity.map((point) => ({ time: point.at, equity: point.value }))
    }];
  });
}

export function SessionComparePage() {
  const [searchParams] = useSearchParams();
  const ids = React.useMemo(() => (searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean).slice(0, 4), [searchParams]);
  const comparison = useQuery(`sessions:compare:${ids.join(",")}`, () => fetchComparison(ids), { enabled: ids.length >= 2, staleAfterMs: 30_000 });
  const sessions = React.useMemo(() => (comparison.data?.sessions ?? []).map((entry) => ({ ...entry.session, metrics: entry.metrics ?? entry.session.metrics })), [comparison.data?.sessions]);
  const series = React.useMemo(() => comparison.data ? comparisonSeries(comparison.data.sessions) : [], [comparison.data]);

  if (ids.length < 2) return <EmptyState title="Select 2–4 sessions" detail="Return to Sessions and choose the runs you want to compare." />;
  if (comparison.isLoading) return <LoadingState title="Loading comparison" />;
  if (comparison.error || !comparison.data) return <ErrorState title="Comparison unavailable" detail={comparison.error?.message} onRetry={comparison.refetch} />;
  return (
    <div className="session-compare page-stack">
      <header className="page-heading"><div><Link className="back-link" to="/sessions"><ArrowLeft size={15} /> Sessions</Link><h1>Compare ({sessions.length})</h1></div></header>
      <section className="panel"><header className="panel-header"><h2>Normalized equity</h2><span>Start = 100</span></header>{series.length ? <SessionChartPanel series={series} /> : <EmptyState title="No comparable equity curves" detail="The API returned no real equity snapshots for these sessions." />}</section>
      <section className="panel"><header className="panel-header"><h2>Metric matrix</h2></header><MetricMatrix sessions={sessions} /></section>
      <section className="panel"><ConfigDiff sessions={sessions} diff={comparison.data.configDiff} /></section>
    </div>
  );
}
