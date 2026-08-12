import { Pause, Square } from "lucide-react";
import * as React from "react";
import { formatMetric } from "../../../packages/shared/format.js";
import { StatusPill } from "../../components/data/StatusPill";
import { api } from "../../lib/api";
import { invalidateQueries } from "../../lib/query";
import type { SessionSummary } from "../../lib/types";

function duration(startedAt?: number | null) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

export function ActiveSessions({ sessions }: { sessions: SessionSummary[] }) {
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const act = async (session: SessionSummary, action: "pause" | "stop") => {
    if (action === "stop" && !window.confirm(`Stop ${session.name}?`)) return;
    setBusyId(session.id);
    setError(null);
    try {
      await api.post(`/sessions/${session.id}/${action}`);
      invalidateQueries("sessions");
      invalidateQueries("overview");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to ${action} session.`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="table-scroll">
      <table className="data-table active-sessions-table" aria-label="Active sessions">
        <thead><tr><th>Status</th><th>Algorithm</th><th>Symbols</th><th className="numeric">Return</th><th className="numeric">Duration</th><th className="numeric">Controls</th></tr></thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td><StatusPill status={session.status} /></td>
              <td><strong>{session.name}</strong>{session.algorithmVersionId ? <small>{session.algorithmVersionId}</small> : null}</td>
              <td>{session.symbols.join(", ")}</td>
              <td className="numeric"><span className={(session.metrics?.returnPercent ?? 0) >= 0 ? "positive" : "negative"}>{formatMetric("returnPercent", session.metrics?.returnPercent)}</span></td>
              <td className="numeric">{duration(session.startedAt)}</td>
              <td className="numeric session-controls">
                <button className="icon-button" type="button" aria-label={`Pause ${session.name}`} disabled={busyId === session.id} onClick={() => void act(session, "pause")}><Pause size={15} /></button>
                <button className="icon-button destructive" type="button" aria-label={`Stop ${session.name}`} disabled={busyId === session.id} onClick={() => void act(session, "stop")}><Square size={13} /></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
  );
}
