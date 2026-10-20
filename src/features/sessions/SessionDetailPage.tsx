import { ArrowLeft, Octagon, Pause, Play } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { formatMoney, formatPercent, formatQty } from "../../../packages/shared/format.js";
import { Metric } from "../../components/data/Metric";
import { StatusPill } from "../../components/data/StatusPill";
import { Timeline } from "../../components/data/Timeline";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { api } from "../../lib/api";
import { describeReason } from "../../lib/orderReasons";
import { invalidateQueries, useQuery } from "../../lib/query";
import { SessionActivity } from "./SessionActivity";
import { SessionChartPanel } from "./SessionChartPanel";
import {
  equitySeriesFrom,
  fetchSession,
  fetchSessionEquity,
  fetchSessionEvents,
  fetchSessionOrders,
  risksForChart,
  tradesForChart
} from "./sessionData";

type DetailTab = "trades" | "events" | "config";

function timestamp(value?: number | null) {
  return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value) : "—";
}

export function SessionDetailPage() {
  const { sessionId = "" } = useParams();
  const [tab, setTab] = React.useState<DetailTab>("trades");
  const [halting, setHalting] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [haltError, setHaltError] = React.useState<string | null>(null);
  // A running session changes underneath the page; poll so new trades appear without a reload.
  const live = { enabled: Boolean(sessionId), staleAfterMs: 15_000, refreshMs: 30_000 };
  const detail = useQuery(`session:${sessionId}`, () => fetchSession(sessionId), live);
  const equity = useQuery(`session:${sessionId}:equity`, () => fetchSessionEquity(sessionId), live);
  const orders = useQuery(`session:${sessionId}:orders`, () => fetchSessionOrders(sessionId), live);
  const events = useQuery(`session:${sessionId}:events`, () => fetchSessionEvents(sessionId), live);

  const series = React.useMemo(() => detail.data && equity.data ? equitySeriesFrom(equity.data, detail.data) : [], [detail.data, equity.data]);
  // Final metrics are only written when a paper session ends; until then derive
  // the live figures from the equity curve and the order ledger.
  const liveMetrics = React.useMemo(() => {
    const points = series[0]?.points ?? [];
    const values = points.map((point) => Number(point.equity)).filter((value) => Number.isFinite(value) && value > 0);
    let peak = values[0] ?? 0;
    let drawdown = 0;
    for (const value of values) {
      peak = Math.max(peak, value);
      if (peak > 0) drawdown = Math.max(drawdown, ((peak - value) / peak) * 100);
    }
    return {
      returnPercent: values.length > 1 ? ((values[values.length - 1] / values[0]) - 1) * 100 : null,
      maxDrawdown: values.length > 1 ? drawdown : null,
      tradeCount: orders.data ? orders.data.filter((order) => order.status === "filled").length : null
    };
  }, [orders.data, series]);
  const start = async () => {
    setStarting(true);
    setHaltError(null);
    try {
      await api.post(`/sessions/${sessionId}/start`);
      invalidateQueries(`session:${sessionId}`);
      invalidateQueries("sessions");
      invalidateQueries("overview");
    } catch (error) {
      setHaltError(error instanceof Error ? error.message : "Unable to start session.");
    } finally {
      setStarting(false);
    }
  };
  const setPaused = async (paused: boolean) => {
    setStarting(true);
    setHaltError(null);
    try {
      await api.post(`/sessions/${sessionId}/${paused ? "pause" : "resume"}`);
      invalidateQueries(`session:${sessionId}`);
      invalidateQueries("sessions");
    } catch (error) {
      setHaltError(error instanceof Error ? error.message : `Unable to ${paused ? "pause" : "resume"} session.`);
    } finally {
      setStarting(false);
    }
  };
  const halt = async () => {
    if (!detail.data || !window.confirm(`Halt ${detail.data.name}? Open positions will be held.`)) return;
    setHalting(true);
    setHaltError(null);
    try {
      await api.post(`/sessions/${sessionId}/halt`, { liquidate: false });
      invalidateQueries(`session:${sessionId}`);
      invalidateQueries("sessions");
    } catch (error) {
      setHaltError(error instanceof Error ? error.message : "Unable to halt session.");
    } finally {
      setHalting(false);
    }
  };

  if (detail.isLoading) return <LoadingState title="Loading session" />;
  if (detail.error || !detail.data) return <ErrorState title="Session unavailable" detail={detail.error?.message} onRetry={detail.refetch} />;
  const session = detail.data;
  const haltReason = session.stopReason ?? session.errorDetail;
  return (
    <div className="session-detail page-stack">
      <header className="detail-heading">
        <div><Link className="back-link" to="/sessions"><ArrowLeft size={15} /> Sessions</Link><div className="title-row"><h1>{session.name}</h1><StatusPill status={session.status} /></div></div>
        <div className="page-actions">
          {session.status === "draft" ? <button className="button primary" type="button" onClick={() => void start()} disabled={starting}><Play size={15} />{starting ? "Starting" : "Start session"}</button> : null}
          {session.status === "running" ? <button className="button secondary" type="button" onClick={() => void setPaused(true)} disabled={starting}><Pause size={15} /> Pause</button> : null}
          {session.status === "paused" ? <button className="button primary" type="button" onClick={() => void setPaused(false)} disabled={starting}><Play size={15} /> Resume</button> : null}
          {session.status === "running" || session.status === "paused" ? <button className="button destructive" type="button" onClick={halt} disabled={halting}><Octagon size={15} />{halting ? "Halting" : "Halt"}</button> : null}
        </div>
      </header>
      {haltError ? <p className="inline-error" role="alert">{haltError}</p> : null}
      {session.status === "halted" ? <div className="halt-banner" role="alert"><Octagon size={17} /><strong>Halted</strong><span>{haltReason ?? "The API did not return a halt reason."}</span></div> : null}
      <p className="session-meta">{session.symbols.join(", ")} · {session.mode} · {session.barInterval} bars · {timestamp(session.startedAt ?? session.windowStart)}–{timestamp(session.endedAt ?? session.windowEnd)} · {session.algorithmVersionId ?? "version unavailable"}</p>
      {session.status === "errored" && session.errorDetail ? <div className="halt-banner" role="alert"><Octagon size={17} /><strong>Errored</strong><span>{session.errorDetail}{/server restarted/i.test(session.errorDetail) ? " Running sessions stop on restart unless the server is started with RESTART_RUNNING_SESSIONS=true." : ""}</span></div> : null}
      {session.status !== "draft" ? <SessionActivity session={session} orders={orders.data ?? []} equity={equity.data} /> : null}

      <section className="metric-strip" aria-label="Session metrics">
        <Metric compact metric="returnPercent" label="Return" value={session.metrics?.returnPercent ?? liveMetrics.returnPercent} />
        <Metric compact metric="maxDrawdown" label="Max drawdown" value={session.metrics?.maxDrawdown ?? liveMetrics.maxDrawdown} />
        <Metric compact metric="sharpe" label="Sharpe" value={session.metrics?.sharpe} />
        <Metric compact metric="winRate" label="Win rate" value={session.metrics?.winRate} />
        <Metric compact metric="tradeCount" label={session.metrics?.tradeCount != null ? "Trades" : "Fills"} value={session.metrics?.tradeCount ?? liveMetrics.tradeCount} />
        <div className="metric compact"><span className="metric-label">vs SPY</span><strong className={`metric-value ${(session.metrics?.vsSpy ?? 0) >= 0 ? "positive" : "negative"}`}>{formatPercent(session.metrics?.vsSpy, { signed: true, precision: 2 })}</strong></div>
      </section>

      <section className="panel session-chart-section">
        <header className="panel-header"><h2>Normalized equity</h2>{equity.isStale ? <StaleBadge updatedAt={equity.updatedAt} /> : null}</header>
        {equity.isLoading ? <LoadingState title="Loading session equity" /> : null}
        {equity.error && !equity.data ? <ErrorState detail={equity.error.message} onRetry={equity.refetch} /> : null}
        {series.length ? <SessionChartPanel series={series} trades={tradesForChart(orders.data ?? [])} riskEvents={risksForChart(events.data ?? [])} interval={session.barInterval} /> : equity.data ? <EmptyState title="No equity yet" detail={session.mode === "paper" && (session.status === "running" || session.status === "paused") ? "The curve starts at the session's first check; see Activity for when that is." : "This session has no recorded equity."} /> : null}
      </section>

      <section className="panel session-ledger">
        <div className="tab-list" role="tablist">
          {(["trades", "events", "config"] as DetailTab[]).map((item) => <button key={item} className={tab === item ? "active" : ""} role="tab" aria-selected={tab === item} type="button" onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
        </div>
        {tab === "trades" ? (
          orders.isLoading ? <LoadingState title="Loading trades" /> : orders.error && !orders.data ? <ErrorState detail={orders.error.message} onRetry={orders.refetch} /> : orders.data?.length ? (
            <div className="table-scroll"><table className="data-table"><thead><tr><th>Time</th><th>Status</th><th>Order</th><th className="numeric">Qty</th><th className="numeric">Fill</th><th>Cause / signal</th></tr></thead><tbody>{orders.data.map((order) => <tr key={order.id}><td>{timestamp(order.filledAt ?? order.submittedAt)}</td><td>{order.status}</td><td>{order.side.toUpperCase()} {order.symbol}</td><td className="numeric">{formatQty(order.qty)}</td><td className="numeric">{formatMoney(order.filledAvgPrice)}</td><td>{order.rejectReason ? <span className="negative" title={order.rejectReason}>{describeReason(order.rejectReason)}</span> : order.signalReason ?? "—"}</td></tr>)}</tbody></table></div>
          ) : <EmptyState title="No orders yet" detail="Orders appear here when the strategy signals. See Activity above for when it next decides." />
        ) : null}
        {tab === "events" ? events.isLoading ? <LoadingState title="Loading events" /> : events.error && !events.data ? <ErrorState detail={events.error.message} onRetry={events.refetch} /> : events.data?.length ? <Timeline items={events.data} /> : <EmptyState title="No events" detail="No risk or state events were returned." /> : null}
        {tab === "config" ? <pre className="config-view">{JSON.stringify({ algorithmVersionId: session.algorithmVersionId, symbols: session.symbols, params: session.params, fillModel: session.fillModel, riskProfile: session.riskProfile, schedule: session.schedule }, null, 2)}</pre> : null}
      </section>
    </div>
  );
}
