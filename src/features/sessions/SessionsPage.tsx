import * as React from "react";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { invalidateQueries, useQuery } from "../../lib/query";
import type { SessionSummary } from "../../lib/types";
import { SessionFilters, type SessionFilterState } from "./SessionFilters";
import { SessionTable } from "./SessionTable";
import { fetchSessions } from "./sessionData";
import { CreateSessionDialog } from "./CreateSessionDialog";

const initialFilters: SessionFilterState = { status: "", mode: "", algorithm: "", days: "7" };

export function SessionsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = React.useState(initialFilters);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const [createOpen, setCreateOpen] = React.useState(false);
  const sessions = useQuery("sessions:list", () => fetchSessions("/sessions?limit=100"), {
    refreshMs: 15_000,
    staleAfterMs: 20_000
  });
  const algorithms = React.useMemo(() => Array.from(new Set((sessions.data ?? []).map((session) => session.algorithmVersionId).filter((id): id is string => Boolean(id)))).sort(), [sessions.data]);
  const filtered = React.useMemo(() => {
    const cutoff = filters.days ? Date.now() - Number(filters.days) * 86_400_000 : 0;
    return (sessions.data ?? []).filter((session) => {
      const at = session.startedAt ?? session.windowStart ?? 0;
      return (!filters.status || session.status === filters.status)
        && (!filters.mode || session.mode === filters.mode)
        && (!filters.algorithm || session.algorithmVersionId === filters.algorithm)
        && (!cutoff || at >= cutoff);
    });
  }, [filters, sessions.data]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 4) next.add(id);
      return next;
    });
  };
  const compare = () => navigate(`/sessions/compare?ids=${encodeURIComponent(Array.from(selected).join(","))}`);

  return (
    <div className="sessions-page page-stack">
      <header className="page-heading">
        <div><h1>Sessions</h1>{sessions.isStale ? <StaleBadge updatedAt={sessions.updatedAt} /> : null}</div>
        <div className="page-actions"><button className="button secondary" type="button" onClick={() => setCreateOpen(true)}><Plus size={14} /> New draft</button><button className="button primary" type="button" disabled={selected.size < 2 || selected.size > 4} onClick={compare}>Compare selected ({selected.size}/4)</button></div>
      </header>
      <SessionFilters value={filters} algorithms={algorithms} onChange={setFilters} />
      <section className="panel sessions-list-panel">
        {sessions.isLoading ? <LoadingState title="Loading sessions" /> : null}
        {sessions.error && !sessions.data ? <ErrorState title="Sessions unavailable" detail={sessions.error.message} onRetry={sessions.refetch} /> : null}
        {sessions.data && filtered.length === 0 ? <EmptyState title="No matching sessions" detail="Adjust the filters or start a real paper or backtest session." /> : null}
        {filtered.length ? <SessionTable sessions={filtered} selected={selected} onSelect={toggle} onOpen={(id) => navigate(`/sessions/${id}`)} /> : null}
        {sessions.data?.length ? <footer className="table-footer">Showing {filtered.length} of {sessions.data.length} loaded sessions</footer> : null}
      </section>
      <CreateSessionDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={(session) => { setCreateOpen(false); invalidateQueries("sessions"); navigate(`/sessions/${session.id}`); }} />
    </div>
  );
}
