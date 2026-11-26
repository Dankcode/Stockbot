/**
 * Chooses a strategy for one symbol without asking the operator.
 *
 * Pure functions only. The service (strategy-pick-service.js) runs the backtests; this
 * module decides which methods may compete, how the history is split, how the results
 * are ranked and which one wins.
 *
 * The rule is a tournament with a holdout:
 *   1. every eligible strategy is backtested against its own control group on the
 *      older part of the history (the "selection window");
 *   2. strategies are ranked by the CONTROL_GROUP.md verdict first, then by percentile
 *      against random entry, then Sharpe, then drawdown;
 *   3. the best few are re-run on the most recent part (the "holdout window"), which
 *      none of them was ranked on, and the first that still makes money and still beats
 *      buy-and-hold wins;
 *   4. if nothing survives, the pick is buy-and-hold and the reason says so.
 *
 * Picking the best of ~25 strategies on one window would overfit on its own. The
 * holdout is what keeps "the AI chose this" from meaning "this got lucky in-sample".
 * It reduces that risk; it does not remove it, so every pick is forward-test evidence.
 */

import { isCryptoSymbol } from "../market/catalog.js";

export const FALLBACK_STRATEGY_IDS = Object.freeze(["core-controls/buy-and-hold", "control-buy-and-hold"]);

/** Plugins whose methods need a research timeline the auto-picker does not provide. */
const RESEARCH_PLUGINS = new Set(["sentiment-pack", "gov-research"]);
/** Plugins whose methods are written for crypto only. */
const CRYPTO_ONLY_PLUGINS = new Set(["crypto-pack"]);
/** A yearly-horizon method cannot complete enough round trips inside a two-year window. */
const UNTESTABLE_HORIZONS = new Set(["yearly"]);

/** buildExperimentPlan caps a plan at 32 strategies. */
export const MAX_CANDIDATES = 32;
export const SELECTION_FRACTION = 2 / 3;
export const MIN_SELECTION_BARS = 120;
export const MIN_HOLDOUT_BARS = 40;
export const HOLDOUT_FINALISTS = 3;

const TIER = Object.freeze({
  "worth-recording": 0,
  "insufficient-evidence": 1,
  "inside-noise": 2,
  "no-timing-edge": 3,
  "below-passive": 4,
  "fails-floor": 5,
  incomplete: 6
});

/** Verdicts that rule a strategy out of the final: it lost money or lost to holding. */
const DISQUALIFYING = new Set(["fails-floor", "below-passive", "incomplete"]);

export const VERDICT_LABEL = Object.freeze({
  "worth-recording": "cleared every control",
  "insufficient-evidence": "beat its controls on too few trades",
  "inside-noise": "profitable but inside random-entry noise",
  "no-timing-edge": "profitable but no timing edge",
  "below-passive": "did not beat buy-and-hold",
  "fails-floor": "lost money",
  incomplete: "did not run"
});

function pluginIdOf(method) {
  return method.pluginId ?? method.plugin?.id ?? (method.id.includes("/") ? method.id.split("/")[0] : null);
}

/**
 * Which installed methods may compete for `symbol`.
 * Returns both lists so the evidence can say why a method was left out.
 */
export function eligibleStrategies(methods, { symbol, pairings, researchAvailable = false, includeUploads = false }) {
  const crypto = isCryptoSymbol(symbol);
  const eligible = [];
  const excluded = [];
  const sorted = [...(methods ?? [])].filter((method) => method?.id).sort((a, b) => a.id.localeCompare(b.id));
  for (const method of sorted) {
    if ((method.role ?? "strategy") !== "strategy") continue;
    const pluginId = pluginIdOf(method);
    const skip = (reason) => excluded.push(Object.freeze({ id: method.id, reason }));
    if (method.enabled === false) { skip("disabled"); continue; }
    if (method.version !== undefined && !method.version?.id) { skip("no registered version"); continue; }
    if (method.uploaded && !includeUploads) { skip("uploaded strategies are excluded until the sandbox is fixed"); continue; }
    if (!researchAvailable && (RESEARCH_PLUGINS.has(pluginId) || /sentiment/i.test(method.id))) { skip("needs a research timeline"); continue; }
    if (CRYPTO_ONLY_PLUGINS.has(pluginId) && !crypto) { skip("crypto-only method"); continue; }
    if (UNTESTABLE_HORIZONS.has(method.horizon)) { skip(`${method.horizon} horizon cannot trade enough inside the test window`); continue; }
    if (pairings && !pairings.has(method.id)) { skip("declares no control group"); continue; }
    eligible.push(method);
  }
  const kept = eligible.slice(0, MAX_CANDIDATES);
  for (const method of eligible.slice(MAX_CANDIDATES)) excluded.push(Object.freeze({ id: method.id, reason: `over the ${MAX_CANDIDATES}-strategy cap` }));
  return Object.freeze({ eligible: Object.freeze(kept), excluded: Object.freeze(excluded) });
}

function barTime(bar) {
  return typeof bar.time === "number" ? bar.time : Date.parse(bar.time);
}

/**
 * Splits history into an older selection window and a recent holdout window.
 * Windows are inclusive bar-time bounds, so the two never share a bar.
 * Returns null when there is not enough history to test anything honestly.
 */
export function splitWindow(bars, { fraction = SELECTION_FRACTION } = {}) {
  const times = (bars ?? []).map(barTime).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const cut = Math.floor(times.length * fraction);
  if (cut < MIN_SELECTION_BARS || times.length - cut < MIN_HOLDOUT_BARS) return null;
  return Object.freeze({
    barCount: times.length,
    selection: Object.freeze({ start: times[0], end: times[cut - 1], bars: cut }),
    holdout: Object.freeze({ start: times[cut], end: times.at(-1), bars: times.length - cut })
  });
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One report group reduced to what the ranking and the evidence need. */
export function summarizeEntry(group) {
  const metrics = group?.metrics ?? null;
  return Object.freeze({
    id: group.strategy.algorithmId,
    name: group.strategy.name ?? group.strategy.algorithmId,
    params: group.strategy.params ?? {},
    verdict: group.verdict,
    reason: group.reason ?? null,
    percentile: number(group.percentile),
    returnPercent: number(metrics?.returnPercent),
    sharpe: number(metrics?.sharpe),
    maxDrawdown: number(metrics?.maxDrawdown),
    closedTradeCount: number(metrics?.closedTradeCount ?? metrics?.tradeCount)
  });
}

function descending(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/** Best first: verdict tier, then percentile vs random entry, Sharpe, shallower drawdown, id. */
export function rankGroups(groups) {
  return Object.freeze((groups ?? []).map(summarizeEntry).sort((a, b) =>
    (TIER[a.verdict] ?? 99) - (TIER[b.verdict] ?? 99) ||
    descending(a.percentile, b.percentile) ||
    descending(a.sharpe, b.sharpe) ||
    descending(a.maxDrawdown === null ? null : -Math.abs(a.maxDrawdown), b.maxDrawdown === null ? null : -Math.abs(b.maxDrawdown)) ||
    a.id.localeCompare(b.id)
  ));
}

/** The strategies worth confirming on the holdout: not disqualified in-sample, best first. */
export function finalistsOf(ranked, count = HOLDOUT_FINALISTS) {
  return Object.freeze(ranked.filter((entry) => !DISQUALIFYING.has(entry.verdict)).slice(0, count));
}

function describe(entry) {
  const label = VERDICT_LABEL[entry.verdict] ?? entry.verdict;
  return entry.percentile === null ? label : `${label}, ${entry.percentile}th percentile vs random entry`;
}

/**
 * The final decision. `holdoutGroups` are the report groups from the holdout run of the
 * finalists. Returns `{ outcome: "selected" | "fallback", algorithmId|null, ... }`; the
 * service resolves the fallback id to an installed buy-and-hold method.
 */
export function choosePick({ ranked, finalists, holdoutGroups = [], window = null }) {
  const holdout = new Map(rankGroups(holdoutGroups).map((entry) => [entry.id, entry]));
  for (const finalist of finalists) {
    const confirmed = holdout.get(finalist.id);
    if (!confirmed || DISQUALIFYING.has(confirmed.verdict)) continue;
    const position = ranked.findIndex((entry) => entry.id === finalist.id) + 1;
    return Object.freeze({
      outcome: "selected",
      algorithmId: finalist.id,
      params: finalist.params,
      selection: finalist,
      holdout: confirmed,
      reason:
        `${finalist.name} ranked #${position} of ${ranked.length} strategies on the selection window ` +
        `(${describe(finalist)}) and held up on the ${window?.holdout?.bars ?? "held-out"}-bar holdout (${describe(confirmed)}).`
    });
  }
  if (finalists.length === 0) {
    return Object.freeze({
      outcome: "fallback",
      algorithmId: null,
      params: {},
      selection: null,
      holdout: null,
      reason: ranked.length === 0
        ? "No strategy could be tested on this ticker, so it holds passively (buy-and-hold)."
        : `None of the ${ranked.length} strategies tested both made money and beat buy-and-hold on the selection window, so this ticker holds passively (buy-and-hold).`
    });
  }
  const vetoes = finalists.map((entry) => `${entry.name}: ${VERDICT_LABEL[holdout.get(entry.id)?.verdict ?? "incomplete"]}`).join("; ");
  return Object.freeze({
    outcome: "fallback",
    algorithmId: null,
    params: {},
    selection: null,
    holdout: null,
    reason: `The top ${finalists.length} in-sample strategies failed on the held-out window (${vetoes}). No active strategy earned it, so this ticker holds passively (buy-and-hold).`
  });
}
