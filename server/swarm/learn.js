/**
 * Learns from closed swarm trades which Discovery inputs preceded good and bad
 * results, and turns only the stable ones into a new, bounded scoring model.
 * Pure and deterministic. The output is data (weights and exclusion rules for
 * fixed, reviewed scoring code), never code.
 *
 * Guards against learning noise:
 * - at least MIN_TRADES closed trades with recorded features;
 * - a feature counts only if its rank correlation with the trade's return
 *   relative to SPY is large for the sample (|rho| >= OVERALL_Z / sqrt(n-1),
 *   3 standard errors, since ~20 inputs are tested at once: on pure noise with
 *   10 inputs and 60 trades this produced a model in 1 of 300 seeds) and has
 *   the same sign and at least HALF_Z standard errors in both the earlier and
 *   the later half of the trades (split-half stability);
 * - each base weight moves at most ±MAX_WEIGHT_CHANGE;
 * - an exclusion rule needs the bad tercile to lose against SPY in both halves.
 */
import { LENSES } from "../discovery/scoring.js";

export const MIN_TRADES = 30;
export const MIN_FEATURE_TRADES = 20;
export const OVERALL_Z = 3.0;
export const HALF_Z = 1.5;
export const MAX_WEIGHT_CHANGE = 0.5;
export const MAX_RULES = 3;
export const MIN_RULE_TRADES = 30;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

function ranks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end) / 2;
    for (let cursor = start; cursor <= end; cursor += 1) result[order[cursor].index] = rank;
    start = end + 1;
  }
  return result;
}

/** Spearman rank correlation; null when either side has no spread. */
export function spearman(xs, ys) {
  if (xs.length < 3) return null;
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (rx.length - 1) / 2;
  let numerator = 0;
  let sx = 0;
  let sy = 0;
  for (let index = 0; index < rx.length; index += 1) {
    numerator += (rx[index] - mean) * (ry[index] - mean);
    sx += (rx[index] - mean) ** 2;
    sy += (ry[index] - mean) ** 2;
  }
  return sx > 0 && sy > 0 ? numerator / Math.sqrt(sx * sy) : null;
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * @param {Array} trades closed trades: { entryAt, excessPct, features, symbol, rationale }
 *        excessPct = the trade's return minus SPY's over the same dates.
 */
export function attribute(trades) {
  const usable = trades.filter((trade) => trade.features && finite(trade.excessPct)).sort((a, b) => a.entryAt - b.entryAt);
  const keys = new Set();
  for (const trade of usable) for (const [key, value] of Object.entries(trade.features)) if (finite(value) || typeof value === "boolean") keys.add(key);
  const half = Math.floor(usable.length / 2);
  const results = [];
  for (const key of [...keys].sort()) {
    const rows = usable.map((trade, order) => ({ x: Number(trade.features[key]), y: trade.excessPct, order, value: trade.features[key] }))
      .filter((row) => typeof row.value === "boolean" || finite(row.value));
    if (rows.length < MIN_FEATURE_TRADES) { results.push({ key, n: rows.length, rho: null, stable: false, reason: "too few trades" }); continue; }
    const first = rows.filter((row) => row.order < half);
    const second = rows.filter((row) => row.order >= half);
    const rho = spearman(rows.map((row) => row.x), rows.map((row) => row.y));
    const rho1 = spearman(first.map((row) => row.x), first.map((row) => row.y));
    const rho2 = spearman(second.map((row) => row.x), second.map((row) => row.y));
    const bar = (n, z) => z / Math.sqrt(Math.max(1, n - 1));
    const stable = [rho, rho1, rho2].every((value) => value !== null)
      && Math.abs(rho) >= bar(rows.length, OVERALL_Z)
      && Math.abs(rho1) >= bar(first.length, HALF_Z) && Math.abs(rho2) >= bar(second.length, HALF_Z)
      && Math.sign(rho) === Math.sign(rho1) && Math.sign(rho) === Math.sign(rho2);
    results.push({ key, n: rows.length, rho, rhoFirstHalf: rho1, rhoSecondHalf: rho2, stable, reason: stable ? null : "not stable across halves" });
  }
  return { usable, features: results };
}

/** A rule excluding the losing tercile of a stable feature, if that tercile lost to SPY in both halves. */
function exclusionRule(usable, feature) {
  const half = Math.floor(usable.length / 2);
  const rows = usable.map((trade, order) => ({ x: trade.features[feature.key], y: trade.excessPct, order })).filter((row) => finite(row.x));
  if (rows.length < MIN_RULE_TRADES) return null;
  const sorted = rows.map((row) => row.x).sort((a, b) => a - b);
  const low = quantile(sorted, 1 / 3);
  const high = quantile(sorted, 2 / 3);
  const rule = feature.rho > 0
    ? { metric: feature.key, condition: "less_than", value: Number(low.toPrecision(6)) }
    : { metric: feature.key, condition: "greater_than", value: Number(high.toPrecision(6)) };
  const inBad = (row) => (rule.condition === "less_than" ? row.x < rule.value : row.x > rule.value);
  const halves = [rows.filter((row) => row.order < half), rows.filter((row) => row.order >= half)];
  const badMeans = halves.map((part) => mean(part.filter(inBad).map((row) => row.y)));
  if (badMeans.some((value) => value === null || value >= 0)) return null;
  return { rule, badMeanFirstHalf: badMeans[0], badMeanSecondHalf: badMeans[1] };
}

/**
 * Fits a learned model on `base` lens weights. Returns { model, lessons }.
 * model is null when there is not enough stable evidence to change anything.
 */
export function learn({ trades, base, modelId }) {
  const { usable, features } = attribute(trades);
  const lessons = { tradeCount: usable.length, base, features, rules: [], weightChanges: [], model: null, reason: null };
  if (usable.length < MIN_TRADES) {
    lessons.reason = `Only ${usable.length} closed trades with recorded features; at least ${MIN_TRADES} are needed before anything is learned.`;
    return { model: null, lessons };
  }
  const stable = new Map(features.filter((feature) => feature.stable).map((feature) => [feature.key, feature]));
  const components = LENSES[base].map((component) => {
    const feature = stable.get(component.key);
    if (!feature) return { key: component.key, weight: component.weight, direction: component.direction, kind: component.kind };
    const helps = Math.sign(feature.rho) === component.direction;
    const change = Math.min(MAX_WEIGHT_CHANGE, Math.abs(feature.rho) * 2) * (helps ? 1 : -1);
    const weight = component.weight * (1 + change);
    lessons.weightChanges.push({ key: component.key, from: component.weight, to: weight, change, rho: feature.rho });
    return { key: component.key, weight, direction: component.direction, kind: component.kind };
  });
  const total = components.reduce((sum, component) => sum + component.weight, 0);
  const normalized = components.map((component) => ({ ...component, weight: Number((component.weight / total).toFixed(6)) }));
  const rules = [...stable.values()].sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho))
    .map((feature) => exclusionRule(usable, feature)).filter(Boolean).slice(0, MAX_RULES);
  lessons.rules = rules;
  if (!lessons.weightChanges.length && !rules.length) {
    lessons.reason = "No Discovery input was a stable predictor of beating SPY across both halves of the trades; the current lenses stay as they are.";
    return { model: null, lessons };
  }
  const model = { modelId, base, components: normalized, exclude: rules.map((entry) => entry.rule) };
  lessons.model = model;
  return { model, lessons };
}

const pct = (value) => (finite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "n/a");
const fixed = (value) => (finite(value) ? value.toFixed(2) : "n/a");

/** Human-readable lessons for the Swarm page. */
export function lessonsMarkdown({ asOfDate, tradingDays, verdicts, lessons, notes, createdArm }) {
  const lines = [`# Swarm review ${asOfDate}`, "", `${tradingDays} trading days since the experiment started.`, "", "## Verdicts", "", "| Arm | Verdict | Return | vs control | Max drawdown | Closed trades | Action |", "|---|---|---|---|---|---|---|"];
  for (const verdict of verdicts) {
    lines.push(`| ${verdict.label} | ${verdict.verdict} | ${pct(verdict.returnPct)} | ${pct(verdict.excessVsControlPct)} | ${pct(verdict.maxDrawdownPct)} | ${verdict.closedTrades} | ${verdict.action} |`);
  }
  lines.push("", "## What the trades say", "", `${lessons.tradeCount} closed trades with recorded Discovery features (return measured against SPY over the same days).`, "");
  if (lessons.reason) lines.push(lessons.reason, "");
  const stable = lessons.features.filter((feature) => feature.stable);
  if (stable.length) {
    lines.push("Stable in both halves of the trades:", "", "| Input | Trades | Rank correlation | Earlier half | Later half |", "|---|---|---|---|---|");
    for (const feature of stable) lines.push(`| ${feature.key} | ${feature.n} | ${fixed(feature.rho)} | ${fixed(feature.rhoFirstHalf)} | ${fixed(feature.rhoSecondHalf)} |`);
    lines.push("");
  } else if (!lessons.reason) lines.push("No input was stable across both halves.", "");
  if (lessons.weightChanges.length) {
    lines.push(`Weight changes to the ${lessons.base} lens (each bounded to ±50%):`, "");
    for (const change of lessons.weightChanges) lines.push(`- ${change.key}: ${change.from.toFixed(3)} → ${change.to.toFixed(3)} (${change.change >= 0 ? "+" : ""}${(change.change * 100).toFixed(0)}%)`);
    lines.push("");
  }
  if (lessons.rules.length) {
    lines.push("Exclusion rules (the losing tercile lost to SPY in both halves):", "");
    for (const entry of lessons.rules) lines.push(`- exclude ${entry.rule.metric} ${entry.rule.condition.replace("_", " ")} ${entry.rule.value} (mean vs SPY ${pct(entry.badMeanFirstHalf)} then ${pct(entry.badMeanSecondHalf)})`);
    lines.push("");
  }
  if (notes?.winners?.length || notes?.losers?.length) {
    lines.push("## Agent notes (descriptive only; they do not change weights)", "");
    for (const trade of notes.winners ?? []) lines.push(`- Win ${trade.symbol} ${pct(trade.excessPct)} vs SPY: ${trade.rationale ?? "no rationale"}`);
    for (const trade of notes.losers ?? []) lines.push(`- Loss ${trade.symbol} ${pct(trade.excessPct)} vs SPY: ${trade.rationale ?? "no rationale"}`);
    lines.push("");
  }
  lines.push("## New arm", "", createdArm ? `Started **${createdArm.label}** (${createdArm.agentName}) on ${createdArm.startDate} with a fresh $100,000 sleeve. It is judged only on its own forward results.` : "None this review.", "");
  lines.push("Results include the LLM agent's own choices: an arm tests \"score + agent\", not the score alone.");
  return lines.join("\n");
}
