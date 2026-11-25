/**
 * Resolves what an agent may research and trade for one task: pinned symbols,
 * the day's Discovery pick, and whatever the sleeve already holds. Pure: the
 * caller supplies the run, its candidates and the holdings, and stores the
 * result on the task so every later check and every audit sees the same list.
 */
import { DEFAULT_UNIVERSE_CAP } from "../../packages/shared/swarm.js";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const SKIP_FEATURES = new Set(["version", "sharesOutstandingMillions", "marketCapReportedMillions", "bars"]);
const TEXT_FEATURES = new Set(["industry", "sector", "reportedCurrency"]);

/** The candidate inputs a learned lens and the learning review read: metrics merged with fundamentals. */
export function candidateInputs(candidate) {
  return {
    ...(candidate.metricsJson ?? candidate.metrics ?? {}),
    ...(candidate.fundamentalsJson ?? candidate.fundamentals ?? {}),
    growthScore: candidate.growthScore ?? null,
    holdScore: candidate.holdScore ?? null
  };
}

/** The numeric, boolean and sector-like inputs recorded with a buy so a later review can learn from them. */
export function featureSnapshot(candidate) {
  const features = {};
  for (const [key, value] of Object.entries(candidateInputs(candidate))) {
    if (SKIP_FEATURES.has(key)) continue;
    if (finite(value) || typeof value === "boolean") features[key] = value;
    else if (TEXT_FEATURES.has(key) && typeof value === "string" && value.length <= 80) features[key] = value;
  }
  features.growthScore = finite(candidate.growthScore) ? candidate.growthScore : null;
  features.holdScore = finite(candidate.holdScore) ? candidate.holdScore : null;
  return features;
}

function percentileScorer(values, direction) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return (value) => {
    if (!finite(value) || sorted.length < 2) return null;
    let below = 0;
    let equal = 0;
    for (const item of sorted) { if (item < value) below += 1; else if (item === value) equal += 1; }
    const rank = (below + (equal - 1) / 2) / (sorted.length - 1);
    return direction > 0 ? rank : 1 - rank;
  };
}

/** True when a rule excludes these inputs. A missing value never excludes. */
export function excludedBy(rules, inputs) {
  return (rules ?? []).find((rule) => {
    const value = inputs[rule.metric];
    if (!finite(value)) return false;
    return rule.condition === "less_than" ? value < rule.value : value > rule.value;
  }) ?? null;
}

/**
 * Scores a whole run with a learned model: the same percentile-rank weighted
 * average as Discovery's own lenses, over the model's components. Returns a
 * Map symbol -> 0..100 (null when no component was measured).
 */
export function scoreWithModel(candidates, model) {
  const inputs = candidates.map((candidate) => ({ symbol: candidate.symbol, values: candidateInputs(candidate) }));
  const scorers = model.components.map((component) => ({
    ...component,
    rank: component.kind === "rank" ? percentileScorer(inputs.map((entry) => entry.values[component.key]), component.direction) : null
  }));
  const scores = new Map();
  for (const entry of inputs) {
    let total = 0;
    let weight = 0;
    for (const component of scorers) {
      const value = entry.values[component.key];
      const score = component.kind === "flag"
        ? (typeof value === "boolean" ? (value === (component.direction > 0) ? 1 : 0) : null)
        : component.rank(value);
      if (score === null) continue;
      total += score * component.weight;
      weight += component.weight;
    }
    scores.set(entry.symbol, weight > 0 ? Math.round((total / weight) * 100) : null);
  }
  return scores;
}

/**
 * @param {object} input
 * @param {object} input.universe     the plan's universe
 * @param {object|null} input.run     latest discovery run ({id, status, completedAt}) or null
 * @param {Array}  input.candidates   that run's candidates (repository rows)
 * @param {string[]} input.holdings   symbols with an open position in the sleeve
 * @param {number} input.freshSince   oldest acceptable run completion time
 * @param {number} input.now
 */
export function resolveTaskUniverse({ universe, run = null, candidates = [], holdings = [], freshSince, now }) {
  const entries = [];
  const seen = new Set();
  const add = (entry) => {
    if (seen.has(entry.symbol)) return false;
    seen.add(entry.symbol);
    entries.push(entry);
    return true;
  };
  for (const symbol of universe.symbols ?? []) add({ symbol, source: "pinned" });

  let discovery = null;
  if (universe.discovery) {
    const config = universe.discovery;
    const cap = universe.totalCap ?? DEFAULT_UNIVERSE_CAP;
    const slots = Math.max(0, Math.min(config.top, cap - entries.length));
    discovery = { lens: config.score, top: config.top, cap, runId: run?.id ?? null, runCompletedAt: run?.completedAt ?? null, fallback: null, picked: 0 };
    if (!run) discovery.fallback = "discovery_unavailable";
    else if (run.status !== "completed") discovery.fallback = "discovery_failed";
    else if (!(Number(run.completedAt) >= freshSince)) discovery.fallback = "discovery_stale";
    else {
      const learned = config.score === "learned" ? scoreWithModel(candidates, config.learned) : null;
      const scoreOf = (candidate) => (config.score === "growth" ? candidate.growthScore : config.score === "hold" ? candidate.holdScore : learned.get(candidate.symbol));
      const ranked = candidates
        .map((candidate) => ({ candidate, score: scoreOf(candidate) }))
        .filter(({ score }) => finite(score) && (config.minScore === undefined || score >= config.minScore))
        .filter(({ candidate }) => !excludedBy(config.learned?.exclude, candidateInputs(candidate)))
        .sort((left, right) => right.score - left.score || left.candidate.symbol.localeCompare(right.candidate.symbol));
      let rank = 0;
      for (const { candidate, score } of ranked) {
        if (discovery.picked >= slots) break;
        rank += 1;
        if (add({ symbol: candidate.symbol, source: "discovery", rank, score, lens: config.score, features: featureSnapshot(candidate) })) discovery.picked += 1;
      }
      if (discovery.picked === 0 && slots > 0) discovery.fallback = "discovery_empty";
    }
  }
  for (const symbol of [...holdings].sort()) add({ symbol, source: "holding" });
  return { symbols: entries.map((entry) => entry.symbol), entries, discovery, resolvedAt: now };
}

/** The symbols a task may act on: its frozen universe, or the plan's pinned list for tasks created before universes were frozen. */
export function taskSymbols(task, plan) {
  if (Array.isArray(task?.universeJson?.symbols)) return task.universeJson.symbols;
  return plan?.universe?.symbols ?? [];
}
