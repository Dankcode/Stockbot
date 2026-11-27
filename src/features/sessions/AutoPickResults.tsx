import { RefreshCw, Sparkles } from "lucide-react";
import * as React from "react";
import { Link } from "react-router-dom";
import { invalidateQueries } from "../../lib/query";
import { fetchPickJob, PICK_STATUS_LABEL, type PickJob, type StrategyPick } from "../../lib/strategyPicks";

const ACTIVE = new Set(["queued", "selecting", "confirming"]);
/** No progress write for this long while a phase is running means something is stuck. */
const STALL_MS = 120_000;

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

/** Polls an auto-pick job and shows, per symbol, what is running, how far along, and the result. */
export function AutoPickResults({ job: initial, onSettled }: { job: PickJob; onSettled?: (job: PickJob) => void }) {
  const [job, setJob] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());
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
    const poll = window.setInterval(async () => {
      try {
        setJob(await fetchPickJob(job.jobId));
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }, 3_000);
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearInterval(poll); window.clearInterval(tick); };
  }, [job, onSettled]);

  const done = job.picks.filter((pick) => !ACTIVE.has(pick.status)).length;
  return (
    <div className="auto-pick-results" aria-live="polite">
      <p className="auto-pick-intro"><Sparkles size={14} /> {job.status === "running"
        ? `Choosing strategies: ${done} of ${job.picks.length} stocks done. Stocks are tested one at a time; you can leave this page and come back.`
        : "Stockbot backtested every eligible strategy on each stock, checked the best few on recent data they weren't ranked on, and paper trades the winner. If nothing beat buy-and-hold, it holds passively."}</p>
      <ul>{job.picks.map((pick, index) => <PickRow key={pick.id} pick={pick} now={now} ahead={job.picks.slice(0, index).filter((item) => ACTIVE.has(item.status)).length} />)}</ul>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </div>
  );
}

function PickRow({ pick, now, ahead }: { pick: StrategyPick; now: number; ahead: number }) {
  const active = ACTIVE.has(pick.status);
  const strategy = pick.algorithmId ? pick.algorithmId.split("/").pop() : null;
  const progress = pick.evidenceJson?.progress;
  const timings = pick.evidenceJson?.timings;
  const running = active && pick.status !== "queued";
  const lastUpdate = progress?.updatedAt ?? progress?.startedAt ?? pick.createdAt;
  const stalled = running && now - lastUpdate > STALL_MS;
  const phase = progress?.phase === "holdout" ? "Checking the best on recent data" : progress?.phase === "selection" ? "Testing every strategy" : progress?.phase === "loading" ? "Loading price history" : PICK_STATUS_LABEL[pick.status];
  const percent = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <li className={`auto-pick-row ${pick.status}${stalled ? " stalled" : ""}`}>
      <strong>{pick.symbol}</strong>
      {pick.status === "queued" ? <span className="auto-pick-status">Waiting{ahead ? ` — ${ahead} stock${ahead === 1 ? "" : "s"} ahead` : ""}</span> : null}
      {running ? <>
        <span className="auto-pick-status"><RefreshCw size={13} className="spin" /> {phase}</span>
        {progress?.total ? <span className="auto-pick-count">{progress.done}/{progress.total} backtests{progress.failed ? ` · ${progress.failed} failed` : ""}</span> : null}
        {progress?.startedAt ? <span className="auto-pick-count">{duration(now - progress.startedAt)}</span> : null}
        {percent !== null ? <progress className="auto-pick-bar" max={100} value={percent} aria-label={`${pick.symbol} ${percent}%`} /> : null}
        {progress?.current?.length ? <small>Now running: {progress.current.join(", ")}</small> : null}
        {stalled ? <small className="negative">No progress for {duration(now - lastUpdate)} — a backtest may be hung, or the server restarted. Check the server log.</small> : null}
      </> : null}
      {pick.status === "failed" ? <span className="negative">{pick.error ?? "Failed"}</span> : null}
      {pick.status === "completed" ? <>
        <span className={`auto-pick-strategy ${pick.outcome ?? ""}`}>{pick.outcome === "fallback" ? "Buy-and-hold" : strategy}</span>
        {pick.sessionId ? <Link to={`/sessions/${pick.sessionId}`}>Open session</Link> : null}
        {timings?.totalMs ? <span className="auto-pick-count">took {duration(timings.totalMs)}</span> : null}
        <small>{pick.reason}</small>
        {pick.error ? <small className="negative">{pick.error}</small> : null}
      </> : null}
    </li>
  );
}
