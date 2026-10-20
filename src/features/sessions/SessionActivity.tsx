import { AlertTriangle, Clock, Hourglass, Radio } from "lucide-react";
import { formatMoney } from "../../../packages/shared/format.js";
import { describeCadence, nextDecision } from "../../lib/cadence";
import { describeReason } from "../../lib/orderReasons";
import type { SessionSummary } from "../../lib/types";
import type { SessionOrder } from "./sessionData";

function when(value?: number | null) {
  if (!value) return "—";
  const minutes = Math.round((Date.now() - value) / 60_000);
  const clock = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
  if (minutes < 1) return `just now · ${clock}`;
  if (minutes < 120) return `${minutes} min ago · ${clock}`;
  return clock;
}

function lastCheckFrom(equity: unknown) {
  const points = Array.isArray(equity) ? equity : Array.isArray((equity as { points?: unknown[] })?.points) ? (equity as { points: unknown[] }).points : [];
  const last = points[points.length - 1] as { at?: number; time?: number } | undefined;
  return last?.at ?? last?.time ?? null;
}

/**
 * Answers "is this session doing anything?" — when it decides, when it last
 * checked, what is waiting to fill, and why the last order failed.
 */
export function SessionActivity({ session, orders, equity }: { session: SessionSummary; orders: SessionOrder[]; equity: unknown }) {
  const live = session.mode === "paper" && (session.status === "running" || session.status === "paused");
  const pending = orders.filter((order) => order.status === "pending");
  const byTime = [...orders].sort((left, right) => (right.filledAt ?? right.submittedAt ?? 0) - (left.filledAt ?? left.submittedAt ?? 0));
  const lastFilled = byTime.find((order) => order.status === "filled");
  const lastRejected = byTime.find((order) => order.status === "rejected");
  const rejectedIsLatest = lastRejected && (!lastFilled || (lastRejected.submittedAt ?? 0) > (lastFilled.submittedAt ?? 0));
  const lastCheck = lastCheckFrom(equity);
  return (
    <section className="panel session-activity" aria-label="Session activity">
      <header className="panel-header"><h2>Activity</h2><span>{live ? (session.status === "paused" ? "Paused — risk checks only" : "Watching the market") : session.mode === "backtest" ? "Backtest" : "Not running"}</span></header>
      <div className="activity-grid">
        <div className="activity-item"><Radio size={15} aria-hidden="true" /><div><span>Cadence</span><p>{session.mode === "paper" ? describeCadence(session.barInterval, session.symbols) : "Ran once over historical bars."}</p></div></div>
        <div className="activity-item"><Clock size={15} aria-hidden="true" /><div><span>Last check</span><p>{lastCheck ? when(lastCheck) : "Not yet — waiting for the first bar to close"}</p>{live && session.status === "running" ? <small>{nextDecision(session.barInterval, session.symbols)}</small> : null}</div></div>
        <div className="activity-item"><Hourglass size={15} aria-hidden="true" /><div><span>Waiting to fill</span><p>{pending.length ? pending.map((order) => `${order.side.toUpperCase()} ${order.symbol}`).join(", ") : "Nothing — no open orders"}</p>{pending.length ? <small>{pending[0].signalReason ?? "Signal"} · placed {when(pending[0].submittedAt)}</small> : null}</div></div>
        <div className={`activity-item${rejectedIsLatest ? " warn" : ""}`}>{rejectedIsLatest ? <AlertTriangle size={15} aria-hidden="true" /> : <Radio size={15} aria-hidden="true" />}<div><span>{rejectedIsLatest ? "Last order failed" : "Last trade"}</span>
          {rejectedIsLatest && lastRejected ? <><p>{describeReason(lastRejected.rejectReason)}</p><small>{lastRejected.side.toUpperCase()} {lastRejected.symbol} · {when(lastRejected.resolvedAt ?? lastRejected.submittedAt)}</small></>
            : lastFilled ? <><p>{lastFilled.side.toUpperCase()} {lastFilled.symbol} at {formatMoney(lastFilled.filledAvgPrice)}</p><small>{lastFilled.signalReason ?? "Signal"} · {when(lastFilled.filledAt)}</small></>
            : <p>No trades yet. A trade happens only when the strategy's entry condition is met.</p>}
        </div></div>
      </div>
    </section>
  );
}
