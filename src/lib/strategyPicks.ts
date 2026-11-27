import { api, ApiRequestError } from "./api";

export type PickStatus = "queued" | "selecting" | "confirming" | "completed" | "failed";
export type RankedEntry = {
  id: string;
  name: string;
  verdict: string;
  percentile: number | null;
  returnPercent: number | null;
  sharpe: number | null;
  closedTradeCount: number | null;
};
export type StrategyPick = {
  id: string;
  jobId: string;
  symbol: string;
  status: PickStatus;
  barInterval: string;
  outcome: "selected" | "fallback" | null;
  algorithmId: string | null;
  algorithmVersionId: string | null;
  paramsJson: Record<string, unknown>;
  reason: string | null;
  selectionExperimentId: string | null;
  holdoutExperimentId: string | null;
  evidenceJson: {
    candidates?: string[];
    excluded?: { id: string; reason: string }[];
    ranked?: RankedEntry[];
    finalists?: string[];
    holdout?: RankedEntry[];
    window?: { selection: { bars: number }; holdout: { bars: number } } | null;
    progress?: PickProgress;
    timings?: { selectionMs?: number; holdoutMs?: number; totalMs?: number };
  };
  sessionId: string | null;
  error: string | null;
  createdAt: number;
  completedAt: number | null;
};
export type PickProgress = {
  phase: "loading" | "selection" | "holdout" | "done";
  done: number;
  total: number;
  failed: number;
  current: string[];
  startedAt: number;
  updatedAt?: number;
};
export type PickJob = { jobId: string; status: "running" | "completed" | "partial" | "failed"; picks: StrategyPick[] };

export const MAX_AUTO_SYMBOLS = 10;

export const PICK_STATUS_LABEL: Record<PickStatus, string> = {
  queued: "Waiting",
  selecting: "Testing every strategy",
  confirming: "Checking the best on recent data",
  completed: "Done",
  failed: "Failed"
};

export function requestStrategyPicks(symbols: string[], { startNow = true }: { startNow?: boolean } = {}) {
  return api.post<PickJob>("/strategy-picks", { symbols, startNow });
}

/** Jobs still running on the server, so a reloaded page can show them again. */
export function fetchActivePickJobs() {
  return api.get<PickJob[]>("/strategy-picks/active");
}

export function fetchPickJob(jobId: string) {
  return api.get<PickJob>(`/strategy-picks/jobs/${encodeURIComponent(jobId)}`);
}

/** The automatic pick that created a session, or null when it was picked by hand. */
export async function fetchPickForSession(sessionId: string) {
  try {
    return await api.get<StrategyPick>(`/strategy-picks/by-session/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.code === "STRATEGY_PICK_NOT_FOUND" || error.code === "NOT_FOUND")) return null;
    throw error;
  }
}

export function isAutopickDisabled(error: unknown) {
  return error instanceof ApiRequestError && (error.code === "STRATEGY_AUTOPICK_DISABLED" || (error.status === 404 && error.code === "NOT_FOUND"));
}
