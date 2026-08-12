import { Play, X } from "lucide-react";
import * as React from "react";
import { BAR_INTERVALS, CHART_RANGES, getRangeConfig, isRangeKey, type BarInterval, type RangeKey } from "../../../packages/shared/ranges.js";
import { ErrorState, LoadingState } from "../../components/states/DataStates";
import { api } from "../../lib/api";
import { useQuery } from "../../lib/query";
import type { SessionSummary } from "../../lib/types";
import { fetchAlgorithms, fetchAlgorithmVersions } from "../strategies/algorithmData";

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,31}$/;

export function CreateSessionDialog({ open, initialSymbol = "", initialRange = "3M", onClose, onCreated }: {
  open: boolean;
  initialSymbol?: string;
  initialRange?: string;
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
}) {
  const safeRange = isRangeKey(initialRange) ? initialRange : "3M";
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState<"paper" | "backtest">("paper");
  const [symbols, setSymbols] = React.useState(initialSymbol);
  const [range, setRange] = React.useState<RangeKey>(safeRange);
  const [interval, setInterval] = React.useState<BarInterval>(getRangeConfig(safeRange).interval);
  const [algorithmId, setAlgorithmId] = React.useState("");
  const [versionId, setVersionId] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const algorithms = useQuery("algorithms:list", fetchAlgorithms, { enabled: open, staleAfterMs: 60_000 });
  const versions = useQuery(`algorithm:${algorithmId}:versions`, () => fetchAlgorithmVersions(algorithmId), { enabled: open && Boolean(algorithmId), staleAfterMs: 60_000 });

  React.useEffect(() => {
    if (!open) return;
    setSymbols(initialSymbol);
    setRange(safeRange);
    setInterval(getRangeConfig(safeRange).interval);
    setSubmitError(null);
  }, [initialSymbol, open, safeRange]);

  React.useEffect(() => {
    if (!algorithmId) return setVersionId("");
    const current = algorithms.data?.find((algorithm) => algorithm.id === algorithmId)?.version?.id;
    if (current) setVersionId(current);
  }, [algorithmId, algorithms.data]);

  React.useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  const selectedAlgorithm = algorithms.data?.find((algorithm) => algorithm.id === algorithmId);
  const parsedSymbols = symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  const symbolsValid = parsedSymbols.length > 0 && parsedSymbols.length <= 20 && parsedSymbols.every((symbol) => SYMBOL_PATTERN.test(symbol));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !versionId || !symbolsValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const now = Date.now();
      const rangeConfig = getRangeConfig(range);
      const session = await api.post<SessionSummary>("/sessions", {
        name: name.trim(),
        mode,
        algorithmVersionId: versionId,
        symbols: parsedSymbols,
        barInterval: interval,
        params: selectedAlgorithm?.params ?? {},
        ...(mode === "backtest" ? { windowStart: now - rangeConfig.lookbackDays * 86_400_000, windowEnd: now } : {})
      });
      onCreated(session);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Unable to create draft session.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="create-session-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="create-session-title">Create draft session</h2><p>Choose persisted runtime inputs before starting.</p></div><button className="icon-button" type="button" aria-label="Close create session" onClick={onClose}><X size={16} /></button></header>
        {algorithms.isLoading ? <LoadingState compact title="Loading algorithms" /> : null}
        {algorithms.error ? <ErrorState compact title="Algorithms unavailable" detail={algorithms.error.message} onRetry={algorithms.refetch} /> : null}
        <form onSubmit={submit}>
          <div className="session-dialog-grid">
            <label className="full-field"><span>Name</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Session name" /></label>
            <label><span>Mode</span><select value={mode} onChange={(event) => setMode(event.target.value as "paper" | "backtest")}><option value="paper">Paper</option><option value="backtest">Backtest</option></select></label>
            <label><span>Symbols</span><input required value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="SPY, QQQ" /></label>
            <label><span>Algorithm</span><select required value={algorithmId} onChange={(event) => setAlgorithmId(event.target.value)}><option value="">Select algorithm</option>{algorithms.data?.map((algorithm) => <option key={algorithm.id} value={algorithm.id}>{algorithm.name}</option>)}</select></label>
            <label><span>Version</span><select required value={versionId} onChange={(event) => setVersionId(event.target.value)} disabled={!algorithmId || versions.isLoading}><option value="">Select version</option>{versions.data?.map((version) => <option key={version.id} value={version.id}>{version.id}</option>)}</select></label>
            <label><span>Range</span><select value={range} onChange={(event) => { const next = event.target.value; if (isRangeKey(next)) { setRange(next); setInterval(getRangeConfig(next).interval); } }}>{CHART_RANGES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
            <label><span>Bar interval</span><select value={interval} onChange={(event) => setInterval(event.target.value as BarInterval)}>{BAR_INTERVALS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          </div>
          {!symbolsValid && symbols.trim() ? <p className="inline-error" role="alert">Use 1–20 uppercase-compatible symbols separated by commas.</p> : null}
          {versions.error ? <p className="inline-error" role="alert">{versions.error.message}</p> : null}
          {submitError ? <p className="inline-error" role="alert">{submitError}</p> : null}
          <footer><button className="button secondary" type="button" onClick={onClose}>Cancel</button><button className="button primary" disabled={submitting || !name.trim() || !versionId || !symbolsValid} type="submit"><Play size={14} />{submitting ? "Creating" : "Create draft"}</button></footer>
        </form>
      </section>
    </div>
  );
}
