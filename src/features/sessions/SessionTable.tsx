import { ChevronRight } from "lucide-react";
import { formatMetric } from "../../../packages/shared/format.js";
import { StatusPill } from "../../components/data/StatusPill";
import type { SessionSummary } from "../../lib/types";

function dateLabel(value?: number | null) {
  return value ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value) : "—";
}

export function SessionTable({
  sessions,
  selected,
  onSelect,
  onOpen
}: {
  sessions: SessionSummary[];
  selected: Set<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="table-scroll session-table-wrap">
      <table className="data-table session-table" aria-label="Sessions">
        <thead><tr><th><span className="sr-only">Select</span></th><th>Status</th><th>Name</th><th>Algorithm</th><th>Symbols</th><th>Window</th><th className="numeric">Return</th><th className="numeric">Max drawdown</th><th className="numeric">Trades</th><th><span className="sr-only">Open</span></th></tr></thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id} className={selected.has(session.id) ? "selected" : ""} onDoubleClick={() => onOpen(session.id)}>
              <td><input type="checkbox" checked={selected.has(session.id)} onChange={() => onSelect(session.id)} aria-label={`Select ${session.name}`} /></td>
              <td><StatusPill status={session.status} />{session.status === "halted" && (session.stopReason ?? session.errorDetail) ? <small className="halt-inline">{session.stopReason ?? session.errorDetail}</small> : null}</td>
              <td><button className="table-link" type="button" onClick={() => onOpen(session.id)}>{session.name}</button><small>{dateLabel(session.startedAt ?? session.windowStart)}</small></td>
              <td>{session.algorithmVersionId ?? "—"}</td>
              <td>{session.symbols.join(", ") || "—"}</td>
              <td>{session.barInterval}</td>
              <td className="numeric"><span className={(session.metrics?.returnPercent ?? 0) >= 0 ? "positive" : "negative"}>{formatMetric("returnPercent", session.metrics?.returnPercent)}</span></td>
              <td className="numeric">{formatMetric("maxDrawdown", session.metrics?.maxDrawdown)}</td>
              <td className="numeric">{formatMetric("tradeCount", session.metrics?.tradeCount)}</td>
              <td><button className="icon-button" type="button" aria-label={`Open ${session.name}`} onClick={() => onOpen(session.id)}><ChevronRight size={16} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
