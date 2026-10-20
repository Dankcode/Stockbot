import { Play, X } from "lucide-react";
import * as React from "react";
import { BAR_INTERVALS, CHART_RANGES, getRangeConfig, isRangeKey, type BarInterval, type RangeKey } from "../../../packages/shared/ranges.js";
import { ErrorState, LoadingState } from "../../components/states/DataStates";
import { api } from "../../lib/api";
import { describeCadence, isCryptoSymbol } from "../../lib/cadence";
import { useQuery } from "../../lib/query";
import type { Algorithm, SessionSummary } from "../../lib/types";
import { fetchAlgorithms, fetchAlgorithmVersions } from "../strategies/algorithmData";

const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9./-]{0,31}$/;
type ParamValue = number | string | boolean;

function groupAlgorithms(algorithms: Algorithm[]) {
  const groups = new Map<string, Algorithm[]>();
  for (const algorithm of algorithms) {
    const group = algorithm.id.includes("/") ? algorithm.id.split("/")[0] : "Local methods";
    groups.set(group, [...(groups.get(group) ?? []), algorithm]);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
}

export function CreateSessionDialog({ open, initialSymbol = "", initialRange = "3M", initialName = "", initialAlgorithmId = "", onClose, onCreated }: {
  open: boolean;
  initialSymbol?: string;
  initialAlgorithmId?: string;
  initialRange?: string;
  initialName?: string;
  onClose: () => void;
  onCreated: (session: SessionSummary) => void;
}) {
  const safeRange = isRangeKey(initialRange) ? initialRange : "3M";
  const [name, setName] = React.useState(initialName);
  const [mode, setMode] = React.useState<"paper" | "backtest">("paper");
  const [symbols, setSymbols] = React.useState(initialSymbol);
  const [range, setRange] = React.useState<RangeKey>(safeRange);
  const [interval, setInterval] = React.useState<BarInterval>(getRangeConfig(safeRange).interval);
  const [algorithmId, setAlgorithmId] = React.useState("");
  const [versionId, setVersionId] = React.useState("");
  const [params, setParams] = React.useState<Record<string, ParamValue>>({});
  const [startNow, setStartNow] = React.useState(true);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const algorithms = useQuery("algorithms:list", fetchAlgorithms, { enabled: open, staleAfterMs: 60_000 });
  const versions = useQuery(`algorithm:${algorithmId}:versions`, () => fetchAlgorithmVersions(algorithmId), { enabled: open && Boolean(algorithmId), staleAfterMs: 60_000 });

  React.useEffect(() => {
    if (!open) return;
    setName(initialName);
    setSymbols(initialSymbol);
    setRange(safeRange);
    setInterval(getRangeConfig(safeRange).interval);
    setSubmitError(null);
  }, [initialName, initialSymbol, open, safeRange]);

  const selectedAlgorithm = algorithms.data?.find((algorithm) => algorithm.id === algorithmId);
  const preselected = React.useRef(false);
  React.useEffect(() => {
    if (!open) {
      preselected.current = false;
      return;
    }
    if (preselected.current || !initialAlgorithmId || !algorithms.data) return;
    preselected.current = true;
    if (algorithms.data.some((algorithm) => algorithm.id === initialAlgorithmId)) chooseAlgorithm(initialAlgorithmId);
    // chooseAlgorithm reads the latest form state; it is intentionally not a dependency.
  }, [algorithms.data, initialAlgorithmId, open]);

  React.useEffect(() => {
    if (!algorithmId) {
      setVersionId("");
      setParams({});
      return;
    }
    const current = selectedAlgorithm?.version?.id;
    if (current) setVersionId(current);
    setParams({ ...(selectedAlgorithm?.params ?? {}) });
  }, [algorithmId, selectedAlgorithm]);

  React.useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;
  const parsedSymbols = symbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
  const symbolsValid = parsedSymbols.length > 0 && parsedSymbols.length <= 20 && parsedSymbols.every((symbol) => SYMBOL_PATTERN.test(symbol));
  const cryptoOnly = parsedSymbols.length > 0 && parsedSymbols.every(isCryptoSymbol);

  const chooseAlgorithm = (id: string) => {
    setAlgorithmId(id);
    // Crypto methods are meant for Bitcoin and benefit from a bar that closes many times a day.
    if (id.startsWith("crypto-pack/")) {
      if (!symbols.trim()) setSymbols("BTCUSD");
      if (["1day", "1week", "1month"].includes(interval)) setInterval("1hour");
    }
    if (!name.trim()) {
      const chosen = algorithms.data?.find((algorithm) => algorithm.id === id);
      if (chosen) setName(`${chosen.name} — paper`);
    }
  };

  const setParam = (key: string, raw: string, kind: string) => {
    setParams((current) => ({
      ...current,
      [key]: kind === "number" ? (raw === "" ? "" : Number(raw)) : kind === "boolean" ? raw === "true" : raw
    }));
  };
  const paramsValid = Object.values(params).every((value) => typeof value !== "number" || Number.isFinite(value)) &&
    Object.values(params).every((value) => value !== "");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !versionId || !symbolsValid || !paramsValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const now = Date.now();
      const rangeConfig = getRangeConfig(range);
      let session = await api.post<SessionSummary>("/sessions", {
        name: name.trim(),
        mode,
        algorithmVersionId: versionId,
        symbols: parsedSymbols,
        barInterval: interval,
        params,
        ...(mode === "backtest" ? { windowStart: now - rangeConfig.lookbackDays * 86_400_000, windowEnd: now } : {})
      });
      if (mode === "backtest" || startNow) {
        try {
          session = await api.post<SessionSummary>(`/sessions/${session.id}/start`);
        } catch (reason) {
          // The draft exists; send the user to it so the start error is visible there.
          setSubmitError(reason instanceof Error ? `Draft created, but it could not start: ${reason.message}` : "Draft created, but it could not start.");
        }
      }
      onCreated(session);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "Unable to create session.");
    } finally {
      setSubmitting(false);
    }
  };

  const paramEntries = Object.entries(params);
  const actionLabel = mode === "backtest" ? "Run backtest" : startNow ? "Start paper trading" : "Create draft";
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="session-dialog" role="dialog" aria-modal="true" aria-labelledby="create-session-title" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><h2 id="create-session-title">New session</h2><p>Pick a strategy and the symbols it should trade.</p></div><button className="icon-button" type="button" aria-label="Close create session" onClick={onClose}><X size={16} /></button></header>
        {algorithms.isLoading ? <LoadingState compact title="Loading algorithms" /> : null}
        {algorithms.error ? <ErrorState compact title="Algorithms unavailable" detail={algorithms.error.message} onRetry={algorithms.refetch} /> : null}
        <form onSubmit={submit}>
          <div className="session-dialog-grid">
            <label className="full-field"><span>Strategy</span><select required value={algorithmId} onChange={(event) => chooseAlgorithm(event.target.value)}><option value="">Select a strategy</option>{groupAlgorithms(algorithms.data ?? []).map(([group, items]) => <optgroup key={group} label={group}>{items.map((algorithm) => <option key={algorithm.id} value={algorithm.id}>{algorithm.name}{algorithm.role && algorithm.role !== "strategy" ? ` (${algorithm.role})` : ""}</option>)}</optgroup>)}</select>{selectedAlgorithm?.description ? <small className="field-hint">{selectedAlgorithm.description}</small> : null}</label>
            <label><span>Symbols</span><input required value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="SPY, QQQ or BTCUSD" /></label>
            <label><span>Mode</span><select value={mode} onChange={(event) => setMode(event.target.value as "paper" | "backtest")}><option value="paper">Paper (live, simulated money)</option><option value="backtest">Backtest (history)</option></select></label>
            <label><span>Bar interval</span><select value={interval} onChange={(event) => setInterval(event.target.value as BarInterval)}>{BAR_INTERVALS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            {mode === "backtest" ? <label><span>History window</span><select value={range} onChange={(event) => { const next = event.target.value; if (isRangeKey(next)) { setRange(next); setInterval(getRangeConfig(next).interval); } }}>{CHART_RANGES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label> : <label><span>Version</span><select required value={versionId} onChange={(event) => setVersionId(event.target.value)} disabled={!algorithmId || versions.isLoading}><option value="">Select version</option>{versions.data?.map((version) => <option key={version.id} value={version.id}>{version.id.split(":").pop()}</option>)}</select></label>}
            <label className="full-field"><span>Name</span><input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Session name" /></label>
            {paramEntries.length ? <fieldset className="full-field param-fields"><legend>Parameters</legend>{paramEntries.map(([key, value]) => {
              const kind = typeof (selectedAlgorithm?.params?.[key] ?? value);
              return <label key={key}><span>{key}</span>{kind === "boolean" ? <select value={String(value)} onChange={(event) => setParam(key, event.target.value, kind)}><option value="true">true</option><option value="false">false</option></select> : <input type={kind === "number" ? "number" : "text"} step="any" value={String(value)} onChange={(event) => setParam(key, event.target.value, kind)} />}</label>;
            })}</fieldset> : null}
          </div>
          {mode === "paper" && parsedSymbols.length ? <p className="dialog-note">{describeCadence(interval, parsedSymbols)}{!cryptoOnly && ["1day", "1week", "1month"].includes(interval) ? " Use 1hour bars for more frequent decisions." : ""}</p> : null}
          {!symbolsValid && symbols.trim() ? <p className="inline-error" role="alert">Use 1–20 uppercase-compatible symbols separated by commas.</p> : null}
          {!paramsValid ? <p className="inline-error" role="alert">Every parameter needs a value.</p> : null}
          {versions.error ? <p className="inline-error" role="alert">{versions.error.message}</p> : null}
          {submitError ? <p className="inline-error" role="alert">{submitError}</p> : null}
          <footer>
            {mode === "paper" ? <label className="checkbox-field"><input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} /> Start immediately</label> : null}
            <button className="button secondary" type="button" onClick={onClose}>Cancel</button>
            <button className="button primary" disabled={submitting || !name.trim() || !versionId || !symbolsValid || !paramsValid} type="submit"><Play size={14} />{submitting ? "Working" : actionLabel}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
