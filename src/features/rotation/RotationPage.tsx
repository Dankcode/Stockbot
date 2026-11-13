import * as React from "react";
import { History, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { EmptyState, ErrorState, LoadingState } from "../../components/states/DataStates";
import { useQuery } from "../../lib/query";
import {
  fetchRotation,
  fetchRotationBacktest,
  type RotationBacktest,
  type RotationInputs,
  type RotationRow,
  type RotationScreen
} from "../../lib/rotation";
import { LineChart, Sparkline } from "./RotationCharts";

const percent = (value: number | null | undefined, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`);
const signed = (value: number | null | undefined, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`);
const money = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `$${Math.round(value).toLocaleString()}`);
const tone = (value: number | null | undefined) => (value === null || value === undefined || value === 0 ? "" : value > 0 ? "rl-up" : "rl-down");
const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const GATES: [keyof RotationRow, string][] = [["bars", "history"], ["price", "price"], ["adv20", "liquidity"], ["trend", "trend"], ["rsi14", "rsi"]];
type Filter = "all" | "eligible" | "selected";

function gateState(row: RotationRow, gate: string) {
  const text = row.blockers.join(" ");
  const failed = gate === "history" ? /daily bars/.test(text)
    : gate === "price" ? /price .* below/.test(text)
    : gate === "liquidity" ? /dollar volume|no volume/.test(text)
    : gate === "trend" ? /uptrend/.test(text)
    : /RSI/.test(text);
  return failed ? "no" : "ok";
}

export function RotationPage() {
  const navigate = useNavigate();
  const [inputs, setInputs] = React.useState<RotationInputs>({ top: 10, weighting: "inverse_vol", years: 3, rebalance: 5, stop: 0.15 });
  const [applied, setApplied] = React.useState(inputs);
  const [backtestInputs, setBacktestInputs] = React.useState<RotationInputs | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set());

  const screen = useQuery<RotationScreen>(`rotation:${applied.top}:${applied.weighting}`, () => fetchRotation(applied), { staleAfterMs: 10 * 60_000 });
  const backtest = useQuery<RotationBacktest>(
    `rotation-backtest:${JSON.stringify(backtestInputs)}`,
    () => fetchRotationBacktest(backtestInputs ?? inputs),
    { enabled: backtestInputs !== null, staleAfterMs: 30 * 60_000 }
  );

  const data = screen.data?.available ? screen.data : null;
  React.useEffect(() => {
    if (data) setPicked(new Set(data.selected));
  }, [data]);

  const set = <K extends keyof RotationInputs>(key: K, value: RotationInputs[K]) => setInputs((current) => ({ ...current, [key]: value }));
  const rank = () => {
    if (JSON.stringify(inputs) === JSON.stringify(applied)) void screen.refetch();
    setApplied(inputs);
  };
  const runBacktest = () => {
    if (JSON.stringify(inputs) === JSON.stringify(backtestInputs)) void backtest.refetch();
    setBacktestInputs(inputs);
  };
  const toggle = (symbol: string) => setPicked((current) => {
    const next = new Set(current);
    if (next.has(symbol)) next.delete(symbol);
    else if (next.size < 20) next.add(symbol);
    return next;
  });
  const paperTrade = () => navigate(`/sessions?new=1&algorithm=rotation-momentum&symbols=${encodeURIComponent(Array.from(picked).join(", "))}`);

  const rows = React.useMemo(() => {
    if (!data) return [];
    const term = search.trim().toUpperCase();
    return data.rows
      .filter((row) => filter === "all" || (filter === "eligible" ? row.eligible : row.selected))
      .filter((row) => !term || row.symbol.includes(term) || row.sector.toUpperCase().includes(term));
  }, [data, filter, search]);
  const maxScore = data ? Math.max(0.01, ...data.rows.map((row) => Math.abs(row.score ?? 0))) : 1;
  const targets = data ? Object.entries(data.targets).sort((a, b) => b[1] - a[1]) : [];
  const maxWeight = Math.max(0.01, data?.cashWeight ?? 0, ...targets.map(([, weight]) => weight));
  const bt = backtest.data?.available ? backtest.data : null;

  return (
    <div className="rotation-page">
      <header className="rl-head">
        <div>
          <h1 className="rl-title">Rotation<em>Ledger</em></h1>
          <p className="rl-sub">Ranks the universe on momentum and trend, owns the leaders, holds cash in a downtrend.</p>
        </div>
        <div className="rl-chips">
          {data ? <>
            <span className="rl-chip">as of {day(data.asOf)}</span>
            <span className="rl-chip">{data.sources.join(" · ") || "provider"}</span>
            <span className={`rl-chip ${data.regime.riskOn ? "on" : "off"}`}>{data.regime.riskOn ? "risk on" : data.regime.riskOn === false ? "risk off · cash" : "regime unmeasured"}</span>
          </> : null}
        </div>
      </header>

      <section className="rl-panel rl-controls" aria-label="Rotation inputs">
        <label>positions<input type="number" min={1} max={40} value={inputs.top} onChange={(event) => set("top", Number(event.target.value))} /></label>
        <label>weighting<select value={inputs.weighting} onChange={(event) => set("weighting", event.target.value as RotationInputs["weighting"])}><option value="inverse_vol">inverse volatility</option><option value="equal">equal</option></select></label>
        <label>backtest years<input type="number" min={1} max={7} step={0.5} value={inputs.years} onChange={(event) => set("years", Number(event.target.value))} /></label>
        <label>rebalance days<input type="number" min={1} max={63} value={inputs.rebalance} onChange={(event) => set("rebalance", Number(event.target.value))} /></label>
        <label>trailing stop<input type="number" min={0} max={0.9} step={0.01} value={inputs.stop} onChange={(event) => set("stop", Number(event.target.value))} /></label>
        <div className="rl-actions">
          <button className="rl-btn" type="button" onClick={rank} disabled={screen.isFetching}>{screen.isFetching ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />} Re-rank</button>
          <button className="rl-btn" type="button" onClick={runBacktest} disabled={backtest.isFetching}><History size={14} /> {backtest.isFetching ? "Backtesting…" : "Backtest"}</button>
          <button className="rl-btn amber" type="button" onClick={paperTrade} disabled={picked.size === 0}><Play size={14} /> Paper trade {picked.size || ""}</button>
        </div>
      </section>

      {screen.isLoading && !screen.data ? <section className="rl-panel"><LoadingState title="Fetching daily bars for the universe" /></section> : null}
      {screen.error && !screen.data ? <section className="rl-panel"><ErrorState title="Rotation unavailable" detail={screen.error.message} onRetry={rank} /></section> : null}
      {screen.data && !screen.data.available ? <section className="rl-panel"><EmptyState title="No ranking without real bars" detail={`${screen.data.reason} Connect a data provider in Settings → Data providers.`} /></section> : null}

      {data ? <>
        <div className="rl-warning"><ShieldAlert size={15} aria-hidden="true" /><span>{data.survivorshipWarning}{data.errors.length ? ` ${data.errors.length} of ${data.requested} symbols returned no bars and were left out.` : ""}</span></div>

        <section className="rl-hero">
          <div className="rl-panel rl-figure">
            <div className="rl-label">{bt ? `Strategy return · ${day(bt.start).slice(0, 4)}–${day(bt.end).slice(0, 4)}` : "Universe ranked"}</div>
            {bt ? (
              <div className={`rl-big ${tone(bt.metrics.strategy.returnPercent)}`}>{bt.metrics.strategy.returnPercent >= 0 ? "+" : ""}{bt.metrics.strategy.returnPercent.toFixed(1)}<span className="rl-unit">%</span></div>
            ) : (
              <div className="rl-big">{data.scored}<span className="rl-unit">names</span></div>
            )}
            <div className="rl-stats">
              {bt ? <>
                <div><b>{bt.metrics.SPY ? `${bt.metrics.SPY.returnPercent.toFixed(1)}%` : "—"}</b><span>SPY</span></div>
                <div><b>{bt.metrics.strategy.sharpe?.toFixed(2) ?? "—"}</b><span>sharpe</span></div>
                <div><b>{bt.metrics.strategy.maxDrawdown.toFixed(1)}%</b><span>max dd</span></div>
              </> : <>
                <div><b>{data.eligibleCount}</b><span>pass gates</span></div>
                <div><b>{data.selected.length}</b><span>selected</span></div>
                <div><b>{percent(data.cashWeight, 0)}</b><span>cash</span></div>
              </>}
            </div>
          </div>

          <div className="rl-panel">
            <div className="rl-label">Regime <span className="rl-dim">{data.regime.benchmark} {data.regime.close?.toFixed(2)} · {data.regime.window}d {data.regime.sma?.toFixed(2)} · {signed(data.regime.distance)}</span></div>
            <LineChart
              label={`${data.regime.benchmark} against its ${data.regime.window}-day mean`}
              times={data.regimeSeries.map((point) => point.time)}
              series={[{ values: data.regimeSeries.map((point) => point.sma), className: "sma" }, { values: data.regimeSeries.map((point) => point.close), className: "bench", dot: true }]}
              bands={data.regimeSeries.map((point) => (point.sma === null ? null : point.close > point.sma))}
              format={(value) => Math.round(value).toString()}
            />
            <div className="rl-legend"><i className="k bench" />benchmark <i className="k sma" />{data.regime.window}d mean <i className="k on" />risk on <i className="k off" />risk off</div>
          </div>

          <div className="rl-panel">
            <div className="rl-label">Target book <span className="rl-dim">{data.config.weighting.replace("_", " ")} · cap {percent(data.config.maxWeight, 0)} · ≤{data.config.maxPerSector}/sector</span></div>
            <div className="rl-targets">
              {targets.map(([symbol, weight]) => <div key={symbol} className="rl-target"><span>{symbol}</span><i><b style={{ width: `${(weight / maxWeight) * 100}%` }} /></i><span>{percent(weight)}</span></div>)}
              <div className="rl-target cash"><span>CASH</span><i><b style={{ width: `${(data.cashWeight / maxWeight) * 100}%` }} /></i><span>{percent(data.cashWeight)}</span></div>
            </div>
          </div>
        </section>

        <section className="rl-panel">
          <div className="rl-panel-head">
            <div className="rl-label">Ranked universe <span className="rl-dim">{rows.length} of {data.rows.length} · {data.eligibleCount} pass gates · tick to paper trade</span></div>
            <div className="rl-filters">
              {(["all", "eligible", "selected"] as Filter[]).map((value) => <button key={value} type="button" className={filter === value ? "on" : undefined} onClick={() => setFilter(value)}>{value}</button>)}
              <input type="search" placeholder="symbol or sector" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Filter symbols" />
            </div>
          </div>
          <div className="rl-table-wrap">
            <table className="rl-table">
              <thead><tr><th className="sel"><span className="sr-only">Select</span></th><th className="num">#</th><th>symbol</th><th>sector</th><th>score</th><th className="num">12–1m</th><th className="num">6m</th><th className="num">3m</th><th className="num">vol</th><th className="num">rsi</th><th className="num">52w</th><th>60d</th><th className="num">weight</th><th>gates</th></tr></thead>
              <tbody>
                {rows.map((row) => {
                  const score = row.score ?? 0;
                  const width = (Math.abs(score) / maxScore) * 30;
                  return (
                    <tr key={row.symbol} className={row.selected ? "is-selected" : row.eligible ? undefined : "is-blocked"} title={row.blockers.join("; ") || row.note || undefined}>
                      <td className="sel"><input type="checkbox" aria-label={`Select ${row.symbol}`} checked={picked.has(row.symbol)} onChange={() => toggle(row.symbol)} /></td>
                      <td className="num">{row.rank}</td>
                      <td className="sym">{row.symbol}</td>
                      <td className="sector">{row.sector}</td>
                      <td><span className="rl-score"><span>{row.score === null ? "—" : score.toFixed(2)}</span><i>{row.score === null ? null : <b className={score < 0 ? "neg" : undefined} style={score >= 0 ? { left: 30, width } : { left: 30 - width, width }} />}</i></span></td>
                      <td className={`num ${tone(row.mom12_1)}`}>{percent(row.mom12_1, 0)}</td>
                      <td className={`num ${tone(row.mom6m)}`}>{percent(row.mom6m, 0)}</td>
                      <td className={`num ${tone(row.mom3m)}`}>{percent(row.mom3m, 0)}</td>
                      <td className="num">{percent(row.vol20, 0)}</td>
                      <td className="num">{row.rsi14 === null ? "—" : row.rsi14.toFixed(0)}</td>
                      <td className="num">{percent(row.fromHigh, 0)}</td>
                      <td><Sparkline values={row.spark} /></td>
                      <td className="num">{row.weight ? percent(row.weight) : ""}</td>
                      <td><span className="rl-gates">{GATES.map(([, gate]) => <i key={gate} className={gateState(row, gate)} title={gate} />)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </> : null}

      {backtestInputs && backtest.isLoading && !backtest.data ? <section className="rl-panel"><LoadingState title="Walking forward through the universe" /></section> : null}
      {backtest.error && !backtest.data ? <section className="rl-panel"><ErrorState title="Backtest failed" detail={backtest.error.message} onRetry={runBacktest} /></section> : null}
      {backtest.data && !backtest.data.available ? <section className="rl-panel"><EmptyState title="Backtest unavailable" detail={backtest.data.reason} /></section> : null}
      {bt ? (
        <section className="rl-panel rl-backtest">
          <div className="rl-panel-head">
            <div className="rl-label">Walk-forward backtest <span className="rl-dim">{day(bt.start)} → {day(bt.end)} · {money(bt.settings.startingEquity)} · rebalance {bt.settings.rebalanceEvery}d · stop {percent(bt.settings.trailingStop, 0)} · {bt.settings.fillModel.slippageBps}bps · fills at next open</span></div>
            <div className="rl-legend"><i className="k strat" />strategy <i className="k bench" />SPY</div>
          </div>
          <div className="rl-bt-grid">
            <div>
              <LineChart label="Strategy equity against SPY" height={260} times={bt.equityCurve.map((point) => point.time)}
                series={[{ values: bt.benchmarkCurve.map((point) => point.equity), className: "bench" }, { values: bt.equityCurve.map((point) => point.equity), className: "strat", dot: true }]}
                format={(value) => `$${Math.round(value / 1000)}k`} />
              <LineChart label="Strategy drawdown" height={84} zero area times={bt.drawdown.map((point) => point.time)}
                series={[{ values: bt.drawdown.map((point) => point.value), className: "dd" }]} format={(value) => `${Math.round(value * 100)}%`} />
            </div>
            <table className="rl-metrics">
              <thead><tr><th /><th className="num">strategy</th><th className="num">SPY</th><th className="num">cash</th></tr></thead>
              <tbody>
                {([["return", "returnPercent", "%"], ["max drawdown", "maxDrawdown", "%"], ["sharpe", "sharpe", ""], ["sortino", "sortino", ""], ["exposure", "exposurePercent", "%"], ["trades", "tradeCount", ""], ["win rate", "winRate", "%"], ["avg trade", "avgTradePercent", "%"]] as const).map(([label, key, unit]) => (
                  <tr key={key}><td>{label}</td>{(["strategy", "SPY", "cash"] as const).map((method) => {
                    const value = bt.metrics[method]?.[key];
                    return <td key={method} className={`num ${method === "strategy" && key === "returnPercent" ? tone(value) : ""}`}>{value === null || value === undefined ? "—" : `${Number(value).toFixed(unit === "%" || key === "sharpe" || key === "sortino" ? 2 : 0)}${unit}`}</td>;
                  })}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {bt.unfilledRebalance ? <p className="rl-note">The rebalance decided on {day(bt.unfilledRebalance.time)} is unfilled: there is no next open to fill it at.</p> : null}
          <div className="rl-bt-bottom">
            <div>
              <div className="rl-label small">Recent trades</div>
              <div className="rl-table-wrap short">
                <table className="rl-table"><thead><tr><th>date</th><th>symbol</th><th>side</th><th className="num">qty</th><th className="num">price</th><th>reason</th><th className="num">p&amp;l</th></tr></thead>
                  <tbody>{bt.trades.slice().reverse().slice(0, 60).map((trade, index) => <tr key={`${trade.time}-${trade.symbol}-${index}`}><td>{day(trade.time)}</td><td className="sym">{trade.symbol}</td><td className={trade.side === "buy" ? "rl-up" : "rl-down"}>{trade.side}</td><td className="num">{trade.quantity.toFixed(2)}</td><td className="num">{trade.price.toFixed(2)}</td><td className="sector">{trade.reason.replace(/_/g, " ")}</td><td className={`num ${tone(trade.pnlPercent)}`}>{trade.pnlPercent === null ? "" : `${trade.pnlPercent.toFixed(1)}%`}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="rl-label small">Rebalances</div>
              <div className="rl-table-wrap short">
                <table className="rl-table"><thead><tr><th>date</th><th>regime</th><th>selection</th></tr></thead>
                  <tbody>{bt.rebalances.slice().reverse().map((entry) => <tr key={entry.time}><td>{day(entry.time)}</td><td className={entry.riskOn ? "rl-up" : "rl-down"}>{entry.riskOn ? "on" : "off"}</td><td className="sector">{entry.selected.join(" ") || "cash"}</td></tr>)}</tbody>
                </table>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
