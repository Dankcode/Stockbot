import * as React from "react";
import { RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { CHART_RANGES, isRangeKey } from "../../../packages/shared/ranges.js";
import { EmptyState, ErrorState, LoadingState } from "../../components/states/DataStates";
import { fetchSymbolSelection } from "../../lib/market";
import { useQuery } from "../../lib/query";

type Source = "auto" | "local" | "active";

function score(candidate: { board: { score: number | null } }) {
  return candidate.board.score === null ? "—" : `${candidate.board.score.toFixed(1)} / 10`;
}

export function SelectionPage() {
  const [range, setRange] = React.useState("1Y");
  const [source, setSource] = React.useState<Source>("auto");
  const [requested, setRequested] = React.useState(false);
  const query = useQuery(
    `selection:${range}:${source}`,
    () => fetchSymbolSelection(range, source),
    { enabled: requested, staleAfterMs: 5 * 60_000 }
  );

  const load = () => setRequested(true);
  const changeRange = (value: string) => {
    if (isRangeKey(value)) setRange(value);
  };

  return (
    <div className="selection-page page-stack">
      <header className="page-heading">
        <div>
          <h1>Symbol selector</h1>
          <p className="selection-subtitle">Ranks tradeability and measurement quality; it does not predict returns or start a trade.</p>
        </div>
        <div className="page-actions">
          <button className="button primary" type="button" onClick={load} disabled={query.isLoading}>
            {query.isLoading ? <RefreshCw size={14} className="spin" /> : <Sparkles size={14} />} Rank candidates
          </button>
        </div>
      </header>

      <section className="panel selection-controls" aria-label="Selection inputs">
        <label><span>Universe</span><select value={source} onChange={(event) => setSource(event.target.value as Source)}><option value="auto">Auto — live screen when available</option><option value="active">Most active stocks</option><option value="local">Local catalogue</option></select></label>
        <label><span>Window</span><select value={range} onChange={(event) => changeRange(event.target.value)}>{CHART_RANGES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        <div className="selection-control-note"><ShieldCheck size={16} /> Recommendations require an explicit next action; no session or backtest is launched here.</div>
      </section>

      {!requested ? <section className="panel"><EmptyState title="Ready to rank candidates" detail="Choose a universe and window, then rank. The screen is deterministic and never uses backtest performance." /></section> : null}
      {query.isLoading && !query.data ? <section className="panel"><LoadingState title="Scoring tradeability" /></section> : null}
      {query.error && !query.data ? <section className="panel"><ErrorState title="Selection unavailable" detail={query.error.message} onRetry={load} /></section> : null}
      {query.data ? <>
        <section className="selection-summary panel">
          <div><strong>{query.data.universe.source}</strong><span>{query.data.scored}/{query.data.requested} candidates scored · {query.data.eligibleCount} passed hard gates</span></div>
          <p>{query.data.caption}</p>
        </section>
        {query.data.universe.fallback ? <div className="inline-error">Live screen unavailable; ranked the local catalogue instead. This is a shortlist, not a market-wide selection.</div> : null}
        {query.data.universe.forwardTestOnly ? <div className="selection-warning">Forward-test-only universe. {query.data.universe.survivorshipWarning} This view deliberately offers no historical backtest action.</div> : null}
        <section className="panel">
          <header className="panel-header"><h2>Recommended for measurement</h2><span>Score · confidence · reason</span></header>
          <div className="table-scroll"><table className="data-table selection-table"><thead><tr><th>Symbol</th><th className="numeric">Board B</th><th>Confidence</th><th>Reason</th></tr></thead><tbody>{query.data.recommended.map((candidate) => <tr key={candidate.symbol}><td><strong>{candidate.symbol}</strong>{candidate.forwardTestOnly ? <small>Forward-test only</small> : null}</td><td className="numeric">{score(candidate)}</td><td>{candidate.board.confidence}</td><td>{candidate.board.reasons[0]}</td></tr>)}</tbody></table></div>
          {query.data.recommended.length === 0 ? <EmptyState title="No candidates passed the gates" detail="Review the exclusions; gate failures are shown instead of being scored down." /> : null}
        </section>
        {query.data.excluded.length ? <section className="panel"><header className="panel-header"><h2>Excluded by hard gates</h2><span>Not scored down</span></header><div className="table-scroll"><table className="data-table selection-table"><thead><tr><th>Symbol</th><th>Blockers</th></tr></thead><tbody>{query.data.excluded.map((candidate) => <tr key={candidate.symbol}><td>{candidate.symbol}</td><td>{candidate.blockers.join("; ")}</td></tr>)}</tbody></table></div></section> : null}
      </> : null}
    </div>
  );
}
