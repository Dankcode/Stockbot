import { ArrowLeft, Play } from "lucide-react";
import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { CHART_RANGES } from "../../../packages/shared/ranges.js";
import { Metric } from "../../components/data/Metric";
import { EmptyState, ErrorState, LoadingState } from "../../components/states/DataStates";
import { api } from "../../lib/api";
import { useQuery } from "../../lib/query";
import type { Metrics } from "../../../packages/shared/schemas.js";
import { formatMetric } from "../../../packages/shared/format.js";
import { fetchAlgorithm, fetchAlgorithmVersions, unwrapBacktest } from "./algorithmData";

type BacktestControl = { id: string; name: string; metrics: Partial<Metrics> };
type BacktestResult = {
  metrics?: Partial<Metrics> & { vsSpy?: number | null };
  controls?: BacktestControl[];
  comparison?: { vsSpyPercent?: number | null; vsCashPercent?: number | null };
  id?: string;
};

const COMPARISON_METRICS = ["returnPercent", "finalEquity", "maxDrawdown", "sharpe", "tradeCount"] as const;

export function StrategyDetailPage() {
  const { algorithmId = "" } = useParams();
  const detail = useQuery(`algorithm:${algorithmId}`, () => fetchAlgorithm(algorithmId), { enabled: Boolean(algorithmId), staleAfterMs: 60_000 });
  const versions = useQuery(`algorithm:${algorithmId}:versions`, () => fetchAlgorithmVersions(algorithmId), { enabled: Boolean(algorithmId), staleAfterMs: 60_000 });
  const algorithm = detail.data;
  const [params, setParams] = React.useState<Record<string, number | string | boolean>>({});
  const [symbol, setSymbol] = React.useState("SPY");
  const [range, setRange] = React.useState("3M");
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<BacktestResult | null>(null);
  const [visibleMethods, setVisibleMethods] = React.useState<Set<string>>(() => new Set(["strategy", "control/spy", "control/cash"]));

  React.useEffect(() => {
    if (algorithm?.params) setParams(algorithm.params);
  }, [algorithm?.id, algorithm?.params]);
  const updateParam = (key: string, value: string) => {
    const original = algorithm?.params?.[key];
    setParams((current) => ({ ...current, [key]: typeof original === "number" ? Number(value) : typeof original === "boolean" ? value === "true" : value }));
  };
  const run = async () => {
    setRunning(true); setError(null); setResult(null);
    try { setResult(unwrapBacktest(await api.post<unknown>(`/algorithms/${algorithmId}/backtest`, { symbol: symbol.trim().toUpperCase(), range, params })) as BacktestResult); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to run backtest."); }
    finally { setRunning(false); }
  };
  const toggleMethod = (id: string) => {
    setVisibleMethods((current) => {
      const next = new Set(current);
      if (next.has(id) && next.size > 1) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const testedMethods = result?.metrics ? [
    { id: "strategy", name: algorithm?.name ?? "Strategy", metrics: result.metrics },
    ...(result.controls ?? [])
  ] : [];
  const visibleResults = testedMethods.filter((method) => visibleMethods.has(method.id));
  const comparison = result?.comparison;

  if (detail.isLoading) return <LoadingState title="Loading strategy" />;
  if (detail.error) return <ErrorState title="Strategy unavailable" detail={detail.error.message} onRetry={detail.refetch} />;
  if (!algorithm) return <EmptyState title="Strategy not found" detail="The API did not return this strategy." />;
  return (
    <div className="strategy-detail page-stack">
      <header className="detail-heading"><div><Link className="back-link" to="/strategies"><ArrowLeft size={15} /> Strategies</Link><h1>{algorithm.name}</h1><p>{algorithm.description ?? "No description returned by the API."}</p></div></header>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div className="strategy-detail-grid">
        <section className="panel params-panel"><header className="panel-header"><h2>Backtest parameters</h2><span>Run override only</span></header>{Object.keys(params).length ? <div className="param-list">{Object.entries(params).map(([key, value]) => <label key={key}><span>{key}</span>{typeof value === "boolean" ? <select value={String(value)} onChange={(event) => updateParam(key, event.target.value)}><option value="true">True</option><option value="false">False</option></select> : <input type={typeof value === "number" ? "number" : "text"} value={String(value)} onChange={(event) => updateParam(key, event.target.value)} />}</label>)}</div> : <EmptyState compact title="No backtest parameters" />}</section>
        <section className="panel backtest-panel"><header className="panel-header"><h2>Backtest</h2></header><div className="backtest-controls"><label><span>Symbol</span><input value={symbol} maxLength={12} onChange={(event) => setSymbol(event.target.value)} /></label><label><span>Range</span><select value={range} onChange={(event) => setRange(event.target.value)}>{CHART_RANGES.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select></label><button className="button primary" type="button" onClick={run} disabled={running || !symbol.trim()}><Play size={14} />{running ? "Running" : "Run backtest"}</button></div>{result?.metrics ? <div className="result-metrics"><Metric compact metric="returnPercent" label="Return" value={result.metrics.returnPercent} /><Metric compact metric="maxDrawdown" label="Max drawdown" value={result.metrics.maxDrawdown} /><Metric compact metric="sharpe" label="Sharpe" value={result.metrics.sharpe} /><Metric compact metric="tradeCount" label="Trades" value={result.metrics.tradeCount} /></div> : <EmptyState compact title="No backtest result" detail="Run this strategy against real historical bars." />}</section>
      </div>
      {testedMethods.length ? <section className="panel tested-methods-panel"><header className="panel-header"><h2>Tested methods</h2><span>Choose comparison groups</span></header><div className="control-checks" role="group" aria-label="Visible tested methods">{testedMethods.map((method) => <label key={method.id}><input type="checkbox" checked={visibleMethods.has(method.id)} onChange={() => toggleMethod(method.id)} /><span><strong>{method.id === "strategy" ? "Strategy" : method.id === "control/spy" ? "SPY buy & hold" : "Cash"}</strong><small>{method.name}</small></span></label>)}</div><div className="table-scroll"><table className="data-table backtest-comparison" aria-label="Backtest method comparison"><thead><tr><th>Metric</th>{visibleResults.map((method) => <th className="numeric" key={method.id}>{method.id === "strategy" ? "Strategy" : method.id === "control/spy" ? "SPY" : "Cash"}</th>)}</tr></thead><tbody>{COMPARISON_METRICS.map((metric) => <tr key={metric}><th>{metric === "returnPercent" ? "Return" : metric === "finalEquity" ? "Final equity" : metric === "maxDrawdown" ? "Max drawdown" : metric === "sharpe" ? "Sharpe" : "Trades"}</th>{visibleResults.map((method) => <td className="numeric" key={method.id}>{formatMetric(metric, method.metrics[metric])}</td>)}</tr>)}</tbody></table></div>{comparison ? <p className="comparison-summary">Strategy vs SPY: <strong>{formatMetric("returnPercent", comparison.vsSpyPercent)}</strong> · Strategy vs Cash: <strong>{formatMetric("returnPercent", comparison.vsCashPercent)}</strong></p> : null}</section> : null}
      <section className="panel version-panel"><header className="panel-header"><h2>Version history</h2></header>{versions.isLoading ? <LoadingState compact title="Loading versions" /> : versions.error ? <ErrorState compact detail={versions.error.message} onRetry={versions.refetch} /> : versions.data?.length ? <ol className="version-list">{versions.data.map((version) => <li key={version.id}><strong>{version.id}</strong><span>{version.sourceHash ?? "hash unavailable"}</span><time>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(version.createdAt)}</time></li>)}</ol> : <EmptyState compact title="No version history" />}</section>
      <section className="panel source-panel"><header className="panel-header"><h2>Source</h2><span>Read-only</span></header>{algorithm.source ? <pre>{algorithm.source}</pre> : <EmptyState compact title="Source unavailable" detail="The API did not return algorithm source." />}</section>
    </div>
  );
}
