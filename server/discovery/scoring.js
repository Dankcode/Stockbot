/**
 * Growth and hold scores for discovery candidates. Deterministic and
 * explainable: each score is a weighted average of percentile ranks within the
 * analysed set, missing inputs drop out of the weights (coverage says how much
 * was measured), and every candidate carries the reasons behind its score.
 * It screens; it does not predict returns. Research comes after it.
 */
import { rotationFactors, TRADING_DAYS } from "../selection/rotation.js";
import { qualityMetrics } from "./indicators.js";

const finite = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const round = (value, digits = 4) => (finite(value) ? Number(Number(value).toFixed(digits)) : null);
const pct = (value) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}%`;

/** Price-history metrics from daily bars (oldest first). */
export function barMetrics(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const end = bars.length - 1;
  const factors = rotationFactors(bars, end);
  const closes = bars.map((bar) => Number(bar.close));
  const window = closes.slice(Math.max(0, closes.length - TRADING_DAYS));
  const returns = window.slice(1).map((close, index) => Math.log(close / window[index])).filter(Number.isFinite);
  const meanReturn = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / Math.max(1, returns.length - 1);
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const close of window) {
    peak = Math.max(peak, close);
    maxDrawdown = Math.min(maxDrawdown, close / peak - 1);
  }
  const mom12 = closes.length > TRADING_DAYS ? closes[end] / closes[end - TRADING_DAYS] - 1 : null;
  const dollarVolumes = bars.slice(-20).map((bar) => Number(bar.close) * Number(bar.volume ?? 0));
  return {
    price: factors.price,
    bars: bars.length,
    mom12m: round(mom12),
    mom12_1: factors.mom12_1,
    mom6m: factors.mom6m,
    mom3m: factors.mom3m,
    fromHigh: factors.fromHigh,
    trend: factors.trend,
    aboveSma200: finite(factors.sma200) ? factors.price > factors.sma200 : null,
    vol1y: returns.length > 20 ? round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS)) : null,
    maxDrawdown1y: round(maxDrawdown),
    adv20: dollarVolumes.length ? Math.round(dollarVolumes.reduce((sum, value) => sum + value, 0) / dollarVolumes.length) : null,
    rsi14: factors.rsi14,
    ...qualityMetrics(bars)
  };
}

// direction: +1 higher is better, -1 lower is better. kind "rank" | "flag" (boolean, scored 0/1).
export const LENSES = Object.freeze({
  growth: Object.freeze([
    { key: "mom12_1", weight: 0.22, direction: 1, kind: "rank", source: "price", label: (v) => `12-1 month momentum ${pct(v)}` },
    { key: "mom6m", weight: 0.16, direction: 1, kind: "rank", source: "price", label: (v) => `6-month return ${pct(v)}` },
    { key: "fromHigh", weight: 0.12, direction: 1, kind: "rank", source: "price", label: (v) => (Math.abs(v) < 0.01 ? "at its 52-week high" : `${(Math.abs(v) * 100).toFixed(0)}% below its 52-week high`) },
    { key: "trend", weight: 0.10, direction: 1, kind: "flag", source: "price", label: (v) => (v ? "uptrend (price > 50-day > 200-day)" : "no uptrend") },
    { key: "revenueGrowthTTM", weight: 0.25, direction: 1, kind: "rank", source: "fundamentals", label: (v) => `revenue growth ${v.toFixed(0)}% year over year` },
    { key: "revenueGrowth3Y", weight: 0.15, direction: 1, kind: "rank", source: "fundamentals", label: (v) => `3-year revenue growth ${v.toFixed(0)}%/yr` }
  ]),
  hold: Object.freeze([
    { key: "vol1y", weight: 0.18, direction: -1, kind: "rank", source: "price", label: (v) => `1-year volatility ${(v * 100).toFixed(0)}%` },
    { key: "maxDrawdown1y", weight: 0.17, direction: 1, kind: "rank", source: "price", label: (v) => `worst 1-year drawdown ${pct(v)}` },
    { key: "aboveSma200", weight: 0.10, direction: 1, kind: "flag", source: "price", label: (v) => (v ? "above its 200-day average" : "below its 200-day average") },
    { key: "mom12m", weight: 0.10, direction: 1, kind: "rank", source: "price", label: (v) => `12-month return ${pct(v)}` },
    { key: "netMarginTTM", weight: 0.17, direction: 1, kind: "rank", source: "fundamentals", label: (v) => `net margin ${v.toFixed(0)}%` },
    { key: "roeTTM", weight: 0.10, direction: 1, kind: "rank", source: "fundamentals", label: (v) => `return on equity ${v.toFixed(0)}%` },
    { key: "debtToEquity", weight: 0.08, direction: -1, kind: "rank", source: "fundamentals", label: (v) => `debt/equity ${v.toFixed(2)}` },
    { key: "revenueGrowth3Y", weight: 0.10, direction: 1, kind: "rank", source: "fundamentals", label: (v) => `3-year revenue growth ${v.toFixed(0)}%/yr` }
  ])
});

function percentiles(candidates, key, direction) {
  const values = candidates.map((candidate) => candidate.inputs[key]).filter(finite).map(Number).sort((a, b) => a - b);
  return (value) => {
    if (!finite(value) || values.length < 2) return null;
    let below = 0;
    let equal = 0;
    for (const item of values) { if (item < value) below += 1; else if (item === value) equal += 1; }
    const rank = (below + (equal - 1) / 2) / (values.length - 1);
    return direction > 0 ? rank : 1 - rank;
  };
}

/**
 * Scores every candidate on both lenses. Each candidate is
 * { symbol, inputs: {...barMetrics, ...fundamentals} }.
 */
export function scoreCandidates(candidates) {
  const scorers = {};
  for (const [lens, components] of Object.entries(LENSES)) {
    scorers[lens] = components.map((component) => ({ ...component, rank: component.kind === "rank" ? percentiles(candidates, component.key, component.direction) : null }));
  }
  return candidates.map((candidate) => {
    const scores = {};
    for (const [lens, components] of Object.entries(scorers)) {
      let total = 0;
      let weight = 0;
      const parts = [];
      for (const component of components) {
        const value = candidate.inputs[component.key];
        const score = component.kind === "flag"
          ? (typeof value === "boolean" ? (value ? 1 : 0) : null)
          : component.rank(value);
        if (score === null) continue;
        total += score * component.weight;
        weight += component.weight;
        parts.push({ key: component.key, score, weight: component.weight, label: component.label(Number(value) || value) });
      }
      const fullWeight = components.reduce((sum, component) => sum + component.weight, 0);
      parts.sort((a, b) => (b.score - 0.5) * b.weight - (a.score - 0.5) * a.weight);
      scores[lens] = {
        score: weight > 0 ? Math.round((total / weight) * 100) : null,
        coverage: round(weight / fullWeight, 2),
        strengths: parts.filter((part) => part.score >= 0.6).slice(0, 3).map((part) => part.label),
        concerns: parts.filter((part) => part.score <= 0.3).sort((a, b) => a.score - b.score).slice(0, 2).map((part) => part.label)
      };
    }
    return { ...candidate, scores };
  });
}
