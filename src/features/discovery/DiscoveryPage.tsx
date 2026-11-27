import * as React from "react";
import { BookmarkPlus, FlaskConical, Play, Plus, RefreshCw, Search, ShieldCheck, Telescope, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { AutoPickResults } from "../sessions/AutoPickResults";
import { fetchActivePickJobs, isAutopickDisabled, MAX_AUTO_SYMBOLS, requestStrategyPicks, type PickJob } from "../../lib/strategyPicks";
import { EmptyState, ErrorState, LoadingState } from "../../components/states/DataStates";
import {
  applyPreset, cancelResearch, DEFAULT_PARAMS, fetchDiscoveryRun, fetchLatestDiscovery, fetchResearchConfig, fetchScreeningOptions, fetchWatchlist, removeWatch,
  requestResearch, setWatch, startDiscoveryRun, WATCH_STATUSES,
  type DiscoveryCandidate, type DiscoveryParams, type FilterCondition, type FilterRule, type Lens, type MetricInfo, type QualityGates, type WatchEntry, type WatchStatus
} from "../../lib/discovery";
import { useQuery } from "../../lib/query";

const pct = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`);
const plainPct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value.toFixed(0)}%`);
const money = (value: number | null | undefined) => {
  if (value === null || value === undefined) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toFixed(2)}`;
};
const cap = (millions: number | null | undefined) => (millions === null || millions === undefined ? "—" : money(millions * 1e6));
const fixed = (value: number | null | undefined, digits = 0) => (value === null || value === undefined ? "—" : value.toFixed(digits));

function CapCell({ fundamentals }: { fundamentals: DiscoveryCandidate["fundamentalsJson"] }) {
  if (fundamentals?.marketCapMillions === null && fundamentals.marketCapReportedMillions) {
    return <td className="numeric discovery-unverified" title={fundamentals.marketCapNote ?? "Not in USD per US share; the market-cap limits were not applied"}>{fundamentals.reportedCurrency ?? "?"} {cap(fundamentals.marketCapReportedMillions).replace("$", "")}<small>unverified</small></td>;
  }
  return <td className="numeric" title={fundamentals?.marketCapNote ?? undefined}>{cap(fundamentals?.marketCapMillions)}</td>;
}

const CONDITIONS: { value: FilterCondition; label: string }[] = [
  { value: "greater_than", label: "above" },
  { value: "less_than", label: "below" },
  { value: "between", label: "between" }
];

function RuleEditor({ rules, metrics, onChange }: { rules: FilterRule[]; metrics: Record<string, MetricInfo>; onChange: (rules: FilterRule[]) => void }) {
  const keys = Object.keys(metrics);
  const update = (index: number, change: Partial<FilterRule>) => onChange(rules.map((rule, position) => {
    if (position !== index) return rule;
    const next = { ...rule, ...change };
    if (change.condition === "between" && !Array.isArray(next.value)) next.value = [next.value, next.value];
    if (change.condition && change.condition !== "between" && Array.isArray(next.value)) next.value = next.value[0];
    return next;
  }));
  const unit = (key: string) => metrics[key]?.unit ?? "";
  return (
    <fieldset className="discovery-rules">
      <legend>Filter rules <small>Every rule must pass. Fundamentals rules only pass for stocks whose fundamentals were fetched.</small></legend>
      {rules.map((rule, index) => (
        <div className="discovery-rule" key={index}>
          <select aria-label="Metric" value={rule.metric} onChange={(event) => update(index, { metric: event.target.value })}>
            {keys.map((key) => <option key={key} value={key}>{metrics[key].label}{metrics[key].source === "fundamentals" ? " (fundamentals)" : ""}</option>)}
          </select>
          <select aria-label="Condition" value={rule.condition} onChange={(event) => update(index, { condition: event.target.value as FilterCondition })}>
            {CONDITIONS.map((condition) => <option key={condition.value} value={condition.value}>{condition.label}</option>)}
          </select>
          {Array.isArray(rule.value)
            ? <><input aria-label="Low" type="number" value={rule.value[0]} onChange={(event) => update(index, { value: [Number(event.target.value), (rule.value as [number, number])[1]] })} /><span>and</span><input aria-label="High" type="number" value={rule.value[1]} onChange={(event) => update(index, { value: [(rule.value as [number, number])[0], Number(event.target.value)] })} /></>
            : <input aria-label="Value" type="number" value={rule.value} onChange={(event) => update(index, { value: Number(event.target.value) })} />}
          <span className="discovery-unit">{unit(rule.metric)}</span>
          <button className="icon-button" type="button" aria-label="Remove rule" onClick={() => onChange(rules.filter((_, position) => position !== index))}><X size={14} /></button>
        </div>
      ))}
      <button className="button secondary small" type="button" disabled={rules.length >= 12 || !keys.length} onClick={() => onChange([...rules, { metric: keys.includes("adx14") ? "adx14" : keys[0], condition: "greater_than", value: 20 }])}><Plus size={14} /> Add rule</button>
    </fieldset>
  );
}

function QualityGateFields({ gates, onChange }: { gates: QualityGates; onChange: (gates: QualityGates) => void }) {
  const set = (key: keyof QualityGates) => (value: number) => onChange({ ...gates, [key]: value });
  return (
    <fieldset className="discovery-gates">
      <legend><label className="check"><input type="checkbox" checked={gates.enabled} onChange={(event) => onChange({ ...gates, enabled: event.target.checked })} /><span>Quality gates</span></label> <small>Drop erratic, spiky or pumped stocks (last 90 sessions). From Gunbot Quant.</small></legend>
      <NumberField label="Max volatility consistency" value={gates.maxVolatilityConsistency} step={0.5} onChange={set("maxVolatilityConsistency")} hint="Std of daily ATR%" />
      <NumberField label="Max daily range (%)" value={gates.maxDailySpikePct} onChange={set("maxDailySpikePct")} hint="Largest high-to-low day" />
      <NumberField label="Max volume on 3 days (%)" value={gates.maxVolumeConcentrationPct} onChange={set("maxVolumeConcentrationPct")} hint="An even tape is about 3%" />
    </fieldset>
  );
}
const score = (value: number | null) => (value === null ? "—" : String(value));

function ScoreCell({ value, coverage }: { value: number | null; coverage: number | null }) {
  const tone = value === null ? "" : value >= 70 ? "positive" : value <= 30 ? "negative" : "";
  return <td className={`numeric discovery-score ${tone}`}>{score(value)}{coverage !== null && coverage < 0.75 ? <small title="Share of the score's inputs that could be measured">{Math.round(coverage * 100)}% measured</small> : null}</td>;
}

function NumberField({ label, value, onChange, step = 1, hint }: { label: string; value: number; onChange: (value: number) => void; step?: number; hint?: string }) {
  return <label><span>{label}</span><input type="number" value={value} step={step} min={0} onChange={(event) => onChange(Number(event.target.value))} />{hint ? <small>{hint}</small> : null}</label>;
}

function FindTab() {
  const navigate = useNavigate();
  const [params, setParams] = React.useState<DiscoveryParams>(DEFAULT_PARAMS);
  const [lens, setLens] = React.useState<Lens>("growth");
  const [runId, setRunId] = React.useState<string | null>(null);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [presetId, setPresetId] = React.useState("balanced");
  const [pickJob, setPickJob] = React.useState<PickJob | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);
  // A pick job keeps running on the server after this page is left; show it again on return.
  React.useEffect(() => {
    let cancelled = false;
    fetchActivePickJobs().then((jobs) => { if (!cancelled && jobs.length) setPickJob((current) => current ?? jobs[0]); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const options = useQuery("discovery:screening", fetchScreeningOptions, { staleAfterMs: 300_000 });
  const presets = options.data?.presets ?? [];
  const choosePreset = (id: string) => {
    setPresetId(id);
    const preset = presets.find((item) => item.id === id);
    if (preset) setParams(applyPreset(preset, options.data?.defaults ?? DEFAULT_PARAMS));
  };
  const query = useQuery(
    `discovery:${runId ?? "latest"}:${lens}`,
    () => (runId ? fetchDiscoveryRun(runId, lens) : fetchLatestDiscovery(lens)),
    { refreshMs: 0, staleAfterMs: 15_000 }
  );
  const running = query.data?.run.status === "running";
  React.useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => query.refetch(), 3_000);
    return () => window.clearInterval(timer);
  }, [running, query]);

  const set = <K extends keyof DiscoveryParams>(key: K) => (value: DiscoveryParams[K]) => { setPresetId("custom"); setParams((current) => ({ ...current, [key]: value })); };
  const start = async () => {
    setStartError(null);
    try {
      const run = await startDiscoveryRun(params);
      setPicked(new Set());
      setRunId(run.id);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  };
  const toggle = (symbol: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(symbol)) next.delete(symbol); else if (next.size < 20) next.add(symbol);
    return next;
  });
  const watchSelected = async () => {
    setBusy("watch");
    try {
      for (const symbol of picked) await setWatch(symbol, { status: "watching", sourceRunId: query.data?.run.id });
      setPicked(new Set());
      query.refetch();
    } finally { setBusy(null); }
  };

  const manualTrade = () => navigate(`/sessions?new=1&algorithm=manual&symbols=${encodeURIComponent(Array.from(picked).join(", "))}`);
  // Stockbot chooses the strategy for each ticker itself; the manual dialog is the
  // fallback when automatic selection is turned off on the server.
  const autoTrade = async () => {
    setBusy("trade");
    setPickError(null);
    try {
      setPickJob(await requestStrategyPicks(Array.from(picked)));
      setPicked(new Set());
    } catch (error) {
      if (isAutopickDisabled(error)) manualTrade();
      else setPickError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(null); }
  };
  const tooMany = picked.size > MAX_AUTO_SYMBOLS;

  const run = query.data?.run;
  const stats = run?.statsJson;
  const candidates = query.data?.candidates ?? [];
  return (
    <>
      <section className="panel discovery-controls" aria-label="Discovery settings">
        <label className="discovery-preset"><span>Preset</span>
          <select value={presetId} onChange={(event) => choosePreset(event.target.value)}>
            {presetId === "custom" ? <option value="custom">Custom</option> : null}
            {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
          <small>{presets.find((preset) => preset.id === presetId)?.description ?? "Your own settings."}</small>
        </label>
        <NumberField label="Min price ($)" value={params.minPrice} onChange={set("minPrice")} />
        <NumberField label="Min avg daily $ volume (M)" value={params.minDollarVolume / 1e6} onChange={(value) => set("minDollarVolume")(value * 1e6)} hint="5-day average, consolidated" />
        <NumberField label="Min market cap ($M)" value={params.minMarketCapMillions} onChange={set("minMarketCapMillions")} />
        <label><span>Max market cap ($M)</span><input type="number" min={0} placeholder="No limit" value={params.maxMarketCapMillions ?? ""} onChange={(event) => set("maxMarketCapMillions")(event.target.value === "" ? null : Number(event.target.value))} /></label>
        <NumberField label="Stocks to analyse" value={params.maxAnalyzed} onChange={set("maxAnalyzed")} hint="Most liquid first, 20–800" />
        <NumberField label="Fundamentals for top" value={params.fundamentalsTop} onChange={set("fundamentalsTop")} hint="Finnhub, about 2 s each" />
        <label className="check"><input type="checkbox" checked={params.excludeSp500} onChange={(event) => set("excludeSp500")(event.target.checked)} /><span>Exclude S&P 500 members</span></label>
        <label className="check"><input type="checkbox" checked={params.excludeBlankCheck} onChange={(event) => set("excludeBlankCheck")(event.target.checked)} /><span>Exclude SPACs</span></label>
        <QualityGateFields gates={params.qualityGates} onChange={set("qualityGates")} />
        {options.data ? <RuleEditor rules={params.filters} metrics={options.data.metrics} onChange={set("filters")} /> : null}
        <div className="discovery-run">
          <button className="button primary" type="button" onClick={start} disabled={running}>
            {running ? <RefreshCw size={14} className="spin" /> : <Search size={14} />} {running ? "Running…" : "Find stocks"}
          </button>
        </div>
      </section>
      {startError ? <div className="inline-error">{startError}</div> : null}

      {query.isLoading && !query.data ? <section className="panel"><LoadingState title="Loading the latest discovery run" /></section> : null}
      {query.error && !query.data ? <section className="panel"><ErrorState title="Discovery unavailable" detail={query.error.message} onRetry={() => query.refetch()} /></section> : null}
      {query.data === null ? <section className="panel"><EmptyState title="No discovery run yet" detail="Set the filters and choose Find stocks. A run screens every listed US stock, takes 1–4 minutes, and nothing trades from it." /></section> : null}

      {run ? <>
        <section className="panel discovery-summary">
          <div><strong>{run.status === "running" ? "Running" : run.status === "failed" ? "Failed" : "Latest run"}</strong><span>{new Date(run.createdAt).toLocaleString()}</span></div>
          {run.status === "running" ? <p><RefreshCw size={13} className="spin" /> {run.progressJson.stage ?? "Starting"}</p> : null}
          {run.status === "failed" ? <p className="negative">{run.error}</p> : null}
          {stats?.universe ? <p>{stats.universe.eligible.toLocaleString()} eligible of {stats.universe.considered.toLocaleString()} listings → {stats.liquidity?.passed?.toLocaleString() ?? "—"} liquid → {stats.liquidity?.analyzed ?? "—"} analysed{stats.quality ? ` → ${stats.quality.passed} passed quality` : ""} → <strong>{stats.candidates ?? "—"} scored</strong></p> : null}
          {stats?.sp500 ? <p>S&P 500 list: {stats.sp500.count} names, {stats.sp500.asOf ?? "undated"} · {stats.sp500.source}</p> : null}
        </section>
        {stats?.universe ? <details className="panel discovery-details"><summary>Why stocks were left out</summary><ul>
          {Object.entries(stats.universe.excluded).sort((a, b) => b[1] - a[1]).map(([reason, count]) => <li key={reason}>{reason}: {count.toLocaleString()}</li>)}
          {stats.liquidity ? <><li>below min price: {stats.liquidity.belowMinPrice}</li><li>below min dollar volume: {stats.liquidity.belowMinDollarVolume}</li><li>no trades in the last {stats.liquidity.dates.length} sessions: {stats.liquidity.noRecentTrades}</li></> : null}
          {stats.bars ? <li>less than 3 months of trading history: {stats.bars.tooShortHistory}</li> : null}
          {stats.quality?.enabled ? Object.entries(stats.quality.removed).map(([reason, count]) => <li key={reason}>quality gate, {reason}: {count}</li>) : null}
          {stats.filters?.map((applied) => <li key={applied.rule}>rule “{applied.rule}”: {applied.removed} failed{applied.missingData ? `, ${applied.missingData} without data` : ""}</li>)}
          {stats.fundamentals ? <li>outside the market-cap range: {stats.fundamentals.outsideMarketCap} · fundamentals fetched {stats.fundamentals.fetched}, failed {stats.fundamentals.failed}{stats.fundamentals.marketCapUnverified ? ` · ${stats.fundamentals.marketCapUnverified} with a market cap that does not match the US price (foreign currency or ADR; cap limits not applied)` : ""}</li> : null}
        </ul></details> : null}
      </> : null}

      {pickJob && run?.status !== "completed" ? <section className="panel"><AutoPickResults job={pickJob} /></section> : null}
      {run?.status === "completed" ? <section className="panel">
        <header className="panel-header">
          <div className="tab-list discovery-lens" role="tablist">
            <button type="button" className={lens === "growth" ? "active" : ""} onClick={() => setLens("growth")}>Growth potential</button>
            <button type="button" className={lens === "hold" ? "active" : ""} onClick={() => setLens("hold")}>Quality to hold</button>
          </div>
          <div className="page-actions">
            <button className="button secondary small" type="button" disabled={!picked.size || busy !== null} onClick={watchSelected}><BookmarkPlus size={14} /> Watch {picked.size || ""}</button>
            <button className="button primary small" type="button" disabled={!picked.size || tooMany || busy !== null} title={tooMany ? `Automatic strategy selection takes up to ${MAX_AUTO_SYMBOLS} stocks at a time` : "Stockbot picks the strategy for each stock and starts paper trading it"} onClick={autoTrade}><Play size={14} /> {busy === "trade" ? "Starting…" : "Paper trade"}</button>
            <button className="button secondary small" type="button" disabled={!picked.size} onClick={manualTrade}>Pick strategy myself</button>
          </div>
        </header>
        {tooMany ? <p className="inline-error">Select at most {MAX_AUTO_SYMBOLS} stocks for automatic strategy selection.</p> : null}
        {pickError ? <p className="inline-error" role="alert">{pickError}</p> : null}
        {pickJob ? <AutoPickResults job={pickJob} /> : null}
        <div className="table-scroll"><table className="data-table discovery-table">
          <thead><tr><th className="select-cell"><span className="sr-only">Select</span></th><th>Stock</th><th className="numeric">Growth</th><th className="numeric">Hold</th><th className="numeric">Price</th><th className="numeric">6 mo</th><th className="numeric">12 mo</th><th className="numeric">From high</th><th className="numeric" title="ADX(14): above 25 is a trending stock">ADX</th><th className="numeric">Rev growth</th><th className="numeric">Mkt cap</th><th>Why it scored</th></tr></thead>
          <tbody>{candidates.map((candidate: DiscoveryCandidate) => {
            const lensScore = candidate.scoresJson[lens];
            return <tr key={candidate.symbol} className={picked.has(candidate.symbol) ? "selected" : undefined}>
              <td className="select-cell"><input type="checkbox" aria-label={`Select ${candidate.symbol}`} checked={picked.has(candidate.symbol)} onChange={() => toggle(candidate.symbol)} /></td>
              <td><strong>{candidate.symbol}</strong>{candidate.watchStatus ? <span className={`watch-tag ${candidate.watchStatus}`}>{candidate.watchStatus}</span> : null}<small>{candidate.name}{candidate.fundamentalsJson?.industry ? ` · ${candidate.fundamentalsJson.industry}` : ""}</small></td>
              <ScoreCell value={candidate.growthScore} coverage={candidate.scoresJson.growth.coverage} />
              <ScoreCell value={candidate.holdScore} coverage={candidate.scoresJson.hold.coverage} />
              <td className="numeric">{money(candidate.metricsJson.price)}</td>
              <td className="numeric">{pct(candidate.metricsJson.mom6m)}</td>
              <td className="numeric">{pct(candidate.metricsJson.mom12m)}</td>
              <td className="numeric">{pct(candidate.metricsJson.fromHigh)}</td>
              <td className="numeric">{fixed(candidate.metricsJson.adx14)}</td>
              <td className="numeric">{plainPct(candidate.fundamentalsJson?.revenueGrowthTTM)}</td>
              <CapCell fundamentals={candidate.fundamentalsJson} />
              <td className="discovery-why">{lensScore.strengths.join(" · ") || "—"}{lensScore.concerns.length ? <small className="negative">{lensScore.concerns.join(" · ")}</small> : null}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {candidates.length === 0 ? <EmptyState title="Nothing passed the filters" detail="Lower the dollar-volume or market-cap floor, or analyse more stocks." /> : null}
        <div className="table-footer"><ShieldCheck size={13} /> Scores rank this run's stocks against each other on measured price history and fundamentals. They are a starting list for research, not a forecast; nothing trades from this page.</div>
      </section> : null}
    </>
  );
}

function WatchlistTab() {
  const list = useQuery("discovery:watchlist", fetchWatchlist, { staleAfterMs: 10_000 });
  const config = useQuery("discovery:research-config", fetchResearchConfig, { staleAfterMs: 60_000 });
  const [error, setError] = React.useState<string | null>(null);
  const [asking, setAsking] = React.useState<string | null>(null);
  const [question, setQuestion] = React.useState("");
  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try { await action(); list.refetch(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const entries = list.data ?? [];
  return (
    <>
      <section className="panel discovery-research-banner">
        <FlaskConical size={16} />
        <div>
          <strong>Research</strong>
          <p>{config.data?.note ?? (config.data?.researchers.length ? `Researchers: ${config.data.researchers.map((item) => item.label ?? item.id).join(", ")}` : "Loading research setup…")}</p>
          <p>Scrapers available to researchers: {config.data?.scrapers.length ? config.data.scrapers.map((scraper) => scraper.id).join(", ") : "none registered yet (RESEARCH_WEB_SOURCES_JSON)"}</p>
        </div>
      </section>
      {error ? <div className="inline-error">{error}</div> : null}
      {list.isLoading && !list.data ? <section className="panel"><LoadingState title="Loading watchlist" /></section> : null}
      {list.data && entries.length === 0 ? <section className="panel"><EmptyState title="Watchlist is empty" detail="Tick stocks on the Find tab and choose Watch." /></section> : null}
      {entries.length ? <section className="panel"><div className="table-scroll"><table className="data-table discovery-table">
        <thead><tr><th>Stock</th><th>Stage</th><th className="numeric">Growth</th><th className="numeric">Hold</th><th className="numeric">12 mo</th><th className="numeric">Mkt cap</th><th>Research</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{entries.map((entry: WatchEntry) => <tr key={entry.symbol}>
          <td><strong>{entry.symbol}</strong>{entry.note ? <small>{entry.note}</small> : null}</td>
          <td><select value={entry.status} aria-label={`Stage for ${entry.symbol}`} onChange={(event) => act(() => setWatch(entry.symbol, { status: event.target.value as WatchStatus }))}>{WATCH_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select></td>
          <td className="numeric">{score(entry.latest?.growthScore ?? null)}</td>
          <td className="numeric">{score(entry.latest?.holdScore ?? null)}</td>
          <td className="numeric">{pct(entry.latest?.metrics.mom12m)}</td>
          <td className="numeric">{cap(entry.latest?.fundamentals?.marketCapMillions)}</td>
          <td className="discovery-why">{entry.research ? <>
            <span className={`watch-tag ${entry.research.status}`}>{entry.research.status}</span>
            {entry.research.researcher ? <small>by {entry.research.researcher}</small> : null}
            {entry.research.resultJson ? <small>{entry.research.resultJson.verdict ? `${entry.research.resultJson.verdict}: ` : ""}{entry.research.resultJson.summary}</small> : null}
          </> : "—"}</td>
          <td className="discovery-actions">
            {entry.research && ["pending", "claimed"].includes(entry.research.status)
              ? <button className="button secondary small" type="button" onClick={() => act(() => cancelResearch(entry.research!.id))}>Cancel research</button>
              : asking === entry.symbol
                ? <span className="discovery-ask"><input autoFocus placeholder="Question for the researcher (optional)" value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="button primary small" type="button" onClick={() => act(async () => { await requestResearch({ symbol: entry.symbol, question: question || undefined }); setAsking(null); setQuestion(""); })}>Queue</button></span>
                : <button className="button secondary small" type="button" onClick={() => { setAsking(entry.symbol); setQuestion(""); }}><FlaskConical size={13} /> Request research</button>}
            <button className="button secondary small" type="button" aria-label={`Remove ${entry.symbol}`} onClick={() => act(() => removeWatch(entry.symbol))}><X size={13} /></button>
          </td>
        </tr>)}</tbody>
      </table></div></section> : null}
    </>
  );
}

export function DiscoveryPage() {
  const [tab, setTab] = React.useState<"find" | "watch">("find");
  return (
    <div className="discovery-page page-stack">
      <header className="page-heading">
        <div>
          <h1><Telescope size={20} /> Discover</h1>
          <p className="selection-subtitle">Find individual US stocks outside the S&P 500 with growth potential or the quality to hold, then queue them for research.</p>
        </div>
      </header>
      <div className="tab-list" role="tablist">
        <button type="button" className={tab === "find" ? "active" : ""} onClick={() => setTab("find")}>Find stocks</button>
        <button type="button" className={tab === "watch" ? "active" : ""} onClick={() => setTab("watch")}>Watchlist & research</button>
      </div>
      {tab === "find" ? <FindTab /> : <WatchlistTab />}
    </div>
  );
}
