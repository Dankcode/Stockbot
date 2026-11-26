/**
 * Runs the strategy tournament for discovered tickers and starts paper sessions with
 * the winners, so the operator never has to pick a strategy by hand.
 *
 * Each symbol is processed in two backtest experiments built with the existing
 * experiment machinery (one session per arm, every arm bound to one version):
 *   selection — every eligible strategy + its plugin-declared controls, older window;
 *   holdout   — the top finalists only, recent window none of them was ranked on.
 * The decision rule itself lives in strategy-pick.js and is pure.
 *
 * Jobs run one at a time in this process. A restart marks unfinished picks failed
 * (recover()); the experiments they created stay readable.
 */
import crypto from "node:crypto";

import { AppError } from "../http/errors.js";
import { buildExperimentPlan, indexPairings } from "../experiments/plan.js";
import {
  FALLBACK_STRATEGY_IDS,
  choosePick,
  eligibleStrategies,
  finalistsOf,
  rankGroups,
  splitWindow
} from "./strategy-pick.js";

const SYMBOL = /^[A-Z0-9][A-Z0-9./-]{0,31}$/;
export const MAX_SYMBOLS_PER_JOB = 10;
/** About two years of daily bars: ~16 months to select on, ~8 months to confirm on. */
const DEFAULT_LOOKBACK_BARS = 504;
const DEFAULT_SEEDS = 20;
const EVIDENCE_TOP = 10;

function jobStatus(picks) {
  if (picks.some((pick) => ["queued", "selecting", "confirming"].includes(pick.status))) return "running";
  if (picks.every((pick) => pick.status === "failed")) return "failed";
  return picks.some((pick) => pick.status === "failed") ? "partial" : "completed";
}

export function createStrategyPickService({
  repositories,
  algorithms,
  experiments,
  supervisor,
  market,
  loadPlugins,
  accountId,
  enabled = true,
  seeds = DEFAULT_SEEDS,
  lookbackBars = DEFAULT_LOOKBACK_BARS,
  idFactory = crypto.randomUUID,
  clock = Date.now,
  logger = console
}) {
  if (!repositories?.strategyPicks || !algorithms || !experiments || !supervisor || !market || typeof loadPlugins !== "function") {
    throw new TypeError("Strategy pick service requires repositories, algorithms, experiments, supervisor, market and loadPlugins.");
  }
  const picks = repositories.strategyPicks;
  let queue = Promise.resolve();

  function assertEnabled() {
    if (!enabled) throw new AppError("STRATEGY_AUTOPICK_DISABLED", "Automatic strategy selection is turned off (STRATEGY_AUTOPICK=0).", 404);
  }

  async function runExperiment({ pickId, symbol, phase, methods, pairings, strategyIds, window }) {
    const plan = buildExperimentPlan({
      methods,
      plugins: pairings,
      selection: { symbol, range: "AUTO", strategies: strategyIds, controls: "auto", seeds },
      now: clock()
    });
    const created = await experiments.create({
      name: `Auto-pick ${symbol} · ${phase} · ${pickId.slice(0, 8)}`,
      mode: "backtest",
      barInterval: "1day",
      plan,
      windowStart: window.start,
      windowEnd: window.end,
      selection: { autoPick: pickId, phase }
    });
    const experimentId = created.experiment.id;
    await experiments.start(experimentId);
    const { report } = await experiments.report(experimentId);
    return { experimentId, groups: report.groups };
  }

  async function resolveFallback() {
    for (const id of FALLBACK_STRATEGY_IDS) {
      try {
        const algorithm = await algorithms.get(id);
        if (algorithm.enabled && algorithm.version?.id) return algorithm;
      } catch { /* try the next one */ }
    }
    throw new AppError("STRATEGY_FALLBACK_MISSING", "No buy-and-hold method is installed to fall back to.", 500);
  }

  async function processPick(pick, { startNow, includeUploads }) {
    const symbol = pick.symbol;
    const update = (changes) => picks.update(pick.id, changes, clock());
    await update({ status: "selecting" });

    const [{ algorithms: methods }, registry] = await Promise.all([algorithms.list(), loadPlugins()]);
    const pairings = indexPairings(registry?.plugins ?? []);
    const { eligible, excluded } = eligibleStrategies(methods, { symbol, pairings, includeUploads });

    const history = await market.getBars(symbol, "3M", { minBars: lookbackBars });
    const window = splitWindow(history?.source === "unavailable" ? [] : history?.bars);
    const evidence = {
      window,
      candidates: eligible.map((method) => method.id),
      excluded,
      ranked: [],
      finalists: [],
      holdout: [],
      historyBars: history?.bars?.length ?? 0
    };

    let decision;
    let selectionExperimentId = null;
    let holdoutExperimentId = null;
    if (!window) {
      decision = {
        outcome: "fallback",
        algorithmId: null,
        params: {},
        reason: `Only ${evidence.historyBars} daily bars of history — not enough to test strategies honestly, so this ticker holds passively (buy-and-hold).`
      };
    } else if (eligible.length === 0) {
      decision = choosePick({ ranked: [], finalists: [] });
    } else {
      const selection = await runExperiment({
        pickId: pick.id, symbol, phase: "selection", methods, pairings,
        strategyIds: eligible.map((method) => method.id), window: window.selection
      });
      selectionExperimentId = selection.experimentId;
      const ranked = rankGroups(selection.groups);
      const finalists = finalistsOf(ranked);
      evidence.ranked = ranked.slice(0, EVIDENCE_TOP);
      evidence.finalists = finalists.map((entry) => entry.id);
      await update({ status: "confirming", selectionExperimentId, evidence });

      let holdoutGroups = [];
      if (finalists.length > 0) {
        const holdout = await runExperiment({
          pickId: pick.id, symbol, phase: "holdout", methods, pairings,
          strategyIds: finalists.map((entry) => entry.id), window: window.holdout
        });
        holdoutExperimentId = holdout.experimentId;
        holdoutGroups = holdout.groups;
        evidence.holdout = rankGroups(holdoutGroups);
      }
      decision = choosePick({ ranked, finalists, holdoutGroups, window });
    }

    const chosen = decision.algorithmId ? await algorithms.get(decision.algorithmId) : await resolveFallback();
    if (!chosen.version?.id) throw new AppError("ALGORITHM_VERSION_NOT_FOUND", `No version is registered for ${chosen.id}.`, 404);
    const params = { ...(chosen.params ?? {}), ...(decision.params ?? {}) };

    let session = await supervisor.create({
      accountId,
      name: `Auto · ${decision.outcome === "fallback" ? "Buy-and-hold (no strategy beat it)" : chosen.name} — ${symbol}`,
      mode: "paper",
      algorithmVersionId: chosen.version.id,
      symbols: [symbol],
      barInterval: pick.barInterval,
      params
    });
    let startError = null;
    if (startNow) {
      try {
        session = await supervisor.start(session.id);
      } catch (cause) {
        startError = cause?.message ?? String(cause);
      }
    }
    evidence.startError = startError;
    return update({
      status: "completed",
      outcome: decision.outcome,
      algorithmId: chosen.id,
      algorithmVersionId: chosen.version.id,
      params,
      reason: decision.reason,
      selectionExperimentId,
      holdoutExperimentId,
      evidence,
      sessionId: session.id,
      error: startError ? `Session created, but it could not start: ${startError}` : null,
      completedAt: clock()
    });
  }

  async function runJob(rows, options) {
    for (const pick of rows) {
      try {
        await processPick(pick, options);
      } catch (cause) {
        logger?.warn?.(`Strategy auto-pick failed for ${pick.symbol}: ${cause?.message ?? cause}`);
        await picks.update(pick.id, { status: "failed", error: cause?.message ?? String(cause), completedAt: clock() }, clock());
      }
    }
  }

  async function request(input = {}) {
    assertEnabled();
    const symbols = [...new Set((input.symbols ?? []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
    if (symbols.length === 0 || symbols.length > MAX_SYMBOLS_PER_JOB || !symbols.every((symbol) => SYMBOL.test(symbol))) {
      throw new AppError("VALIDATION_ERROR", `Give 1–${MAX_SYMBOLS_PER_JOB} valid symbols.`, 400);
    }
    const barInterval = input.barInterval ?? "1day";
    if (barInterval !== "1day") throw new AppError("VALIDATION_ERROR", "Automatic strategy selection tests on daily bars; barInterval must be 1day.", 400);
    const jobId = idFactory();
    const createdAt = clock();
    const rows = [];
    for (const symbol of symbols) rows.push(await picks.create({ id: idFactory(), jobId, symbol, barInterval, createdAt }));
    const options = { startNow: input.startNow !== false, includeUploads: input.includeUploads === true };
    queue = queue.then(() => runJob(rows, options)).catch(() => undefined);
    return getJob(jobId);
  }

  async function getJob(jobId) {
    const rows = await picks.listByJob(jobId);
    if (rows.length === 0) throw new AppError("STRATEGY_PICK_NOT_FOUND", `Unknown pick job: ${jobId}`, 404);
    return Object.freeze({ jobId, status: jobStatus(rows), picks: Object.freeze(rows) });
  }

  return Object.freeze({
    enabled,
    request,
    getJob,
    list: (options) => picks.list(options),
    getBySession: async (sessionId) => {
      const pick = await picks.getBySession(sessionId);
      if (!pick) throw new AppError("STRATEGY_PICK_NOT_FOUND", `No automatic pick created session ${sessionId}.`, 404);
      return pick;
    },
    recover: () => picks.failUnfinished({ at: clock(), error: "Interrupted by a server restart before the pick finished." }),
    /** Resolves once every queued job has finished. For tests and graceful shutdown. */
    drain: () => queue
  });
}
