import { RefreshCw, Sparkles } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { invalidateQueries } from "../../lib/query";
import { fetchPickJob, PICK_STATUS_LABEL, type PickJob, type StrategyPick } from "../../lib/strategyPicks";

const ACTIVE = new Set(["queued", "selecting", "confirming"]);

/** Polls an auto-pick job and shows, per symbol, which strategy Stockbot chose and why. */
export function AutoPickResults({ job: initial, onSettled }: { job: PickJob; onSettled?: (job: PickJob) => void }) {
  const [job, setJob] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const settled = React.useRef(false);
  React.useEffect(() => { setJob(initial); settled.current = false; }, [initial]);
  React.useEffect(() => {
    if (job.status !== "running") {
      if (!settled.current) {
        settled.current = true;
        invalidateQueries("sessions");
        invalidateQueries("overview");
        onSettled?.(job);
      }
      return undefined;
    }
    const timer = window.setInterval(async () => {
      try {
        setJob(await fetchPickJob(job.jobId));
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [job, onSettled]);

  return (
    <div className="auto-pick-results" aria-live="polite">
      <p className="auto-pick-intro"><Sparkles size={14} /> Stockbot backtests every eligible strategy on each ticker, checks the best few on recent data they weren't ranked on, and paper trades the winner. If nothing beats buy-and-hold, it holds passively.</p>
      <ul>{job.picks.map((pick) => <PickRow key={pick.id} pick={pick} />)}</ul>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
  );
}

function PickRow({ pick }: { pick: StrategyPick }) {
  const active = ACTIVE.has(pick.status);
  const strategy = pick.algorithmId ? pick.algorithmId.split("/").pop() : null;
  return (
    <li className={`auto-pick-row ${pick.status}`}>
      <strong>{pick.symbol}</strong>
      {active ? <span className="auto-pick-status"><RefreshCw size={13} className="spin" /> {PICK_STATUS_LABEL[pick.status]}</span> : null}
      {pick.status === "failed" ? <span className="negative">{pick.error ?? "Failed"}</span> : null}
      {pick.status === "completed" ? <>
        <span className={`auto-pick-strategy ${pick.outcome ?? ""}`}>{pick.outcome === "fallback" ? "Buy-and-hold" : strategy}</span>
        {pick.sessionId ? <Link to={`/sessions/${pick.sessionId}`}>Open session</Link> : null}
        <small>{pick.reason}</small>
        {pick.error ? <small className="negative">{pick.error}</small> : null}
      </> : null}
    </li>
  );
}
