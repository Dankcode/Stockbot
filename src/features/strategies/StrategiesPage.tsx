import { ArrowRight, Bot, ToggleLeft, ToggleRight } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState, StaleBadge } from "../../components/states/DataStates";
import { api } from "../../lib/api";
import { invalidateQuery, useQuery } from "../../lib/query";
import type { Algorithm } from "../../lib/types";
import { fetchAlgorithms } from "./algorithmData";

export function StrategiesPage() {
  const algorithms = useQuery("algorithms:list", fetchAlgorithms, { staleAfterMs: 60_000 });
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const sorted = React.useMemo(() => [...(algorithms.data ?? [])].sort((left, right) => left.name.localeCompare(right.name)), [algorithms.data]);

  const toggle = async (algorithm: Algorithm) => {
    setBusy(algorithm.id);
    setError(null);
    try {
      await api.patch(`/algorithms/${algorithm.id}`, { enabled: !algorithm.enabled });
      invalidateQuery("algorithms:list");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to update strategy.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="strategies-page page-stack">
      <header className="page-heading"><div><h1>Strategies</h1>{algorithms.isStale ? <StaleBadge updatedAt={algorithms.updatedAt} /> : null}</div></header>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      {algorithms.isLoading ? <LoadingState title="Loading strategies" /> : null}
      {algorithms.error && !algorithms.data ? <ErrorState title="Strategies unavailable" detail={algorithms.error.message} onRetry={algorithms.refetch} /> : null}
      {algorithms.data && sorted.length === 0 ? <EmptyState title="No strategies installed" detail="Validated algorithms will appear here." /> : null}
      {sorted.length ? <div className="strategy-list">{sorted.map((algorithm) => (
        <article className="strategy-row" key={algorithm.id}>
          <div className="strategy-icon"><Bot size={19} /></div>
          <div className="strategy-copy"><div className="title-row"><h2>{algorithm.name}</h2>{algorithm.version ? <span className="version-label">{algorithm.version.id}</span> : null}</div><p>{algorithm.description ?? "No description returned by the API."}</p><small>{algorithm.author ? `By ${algorithm.author}` : "Author unavailable"}</small></div>
          <div className="strategy-result"><span>Source version</span><strong>{algorithm.version?.hash.slice(0, 10) ?? "—"}</strong><small>{algorithm.params ? `${Object.keys(algorithm.params).length} default parameters` : "Parameters unavailable"}</small></div>
          <button className="icon-button strategy-toggle" type="button" disabled={busy === algorithm.id} aria-label={`${algorithm.enabled ? "Disable" : "Enable"} ${algorithm.name}`} onClick={() => void toggle(algorithm)}>{algorithm.enabled ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}</button>
          <Link className="button secondary" to={`/strategies/${algorithm.id}`}>Open <ArrowRight size={14} /></Link>
        </article>
      ))}</div> : null}
    </div>
  );
}
