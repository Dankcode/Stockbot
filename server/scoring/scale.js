/** Shared scoring primitives. Scores are for triage, never recommendations to trade. */
export const SCORE_ANCHORS = Object.freeze([
  Object.freeze({ min: 0, max: 2, label: "Fails a floor" }),
  Object.freeze({ min: 3, max: 4, label: "Worse than the null" }),
  Object.freeze({ min: 5, max: 6, label: "Inside noise" }),
  Object.freeze({ min: 7, max: 8, label: "Clears its controls" }),
  Object.freeze({ min: 9, max: 10, label: "Replicated" })
]);

function measured(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

export function ramp(value, floor, ceiling) {
  if (!measured(value) || ceiling === floor) return null;
  return Math.max(0, Math.min(1, (Number(value) - floor) / (ceiling - floor)));
}

export function band(value, ideal, span) {
  if (!measured(value) || span <= 0) return null;
  return Math.max(0, 1 - Math.abs(Number(value) - ideal) / span);
}

export function weightedScore(components, weights) {
  const entries = Object.entries(components ?? {});
  const unmeasured = entries.filter(([, value]) => !measured(value)).map(([key]) => key);
  const scored = entries.filter(([, value]) => measured(value));
  const denominator = scored.reduce((sum, [key]) => sum + Number(weights?.[key] ?? 0), 0);
  return Object.freeze({
    score: denominator > 0
      ? scored.reduce((sum, [key, value]) => sum + Number(value) * Number(weights?.[key] ?? 0), 0) / denominator
      : null,
    unmeasured: Object.freeze(unmeasured)
  });
}

export function applyNineGate(score, { replicated = false } = {}) {
  if (!measured(score)) return null;
  return Number(Math.max(0, Math.min(replicated ? 10 : 8, Number(score))).toFixed(1));
}

export function scoreSeparation(sortedScores, threshold = 0.05) {
  if (!Array.isArray(sortedScores) || sortedScores.length < 2) return Object.freeze({ value: null, effectivelyTied: false });
  const value = Number(Number(sortedScores[0]).toFixed(4)) - Number(Number(sortedScores[1]).toFixed(4));
  return Object.freeze({ value: Number(value.toFixed(4)), effectivelyTied: value < threshold });
}

export function makeScore({ score, confidence, reasons, evidence }) {
  if (!Array.isArray(reasons) || reasons.length === 0) throw new TypeError("A score requires at least one reason.");
  if (evidence === undefined) throw new TypeError("A score requires evidence, including an empty array when none was measured.");
  return Object.freeze({ score: measured(score) ? Number(score) : null, confidence, reasons: Object.freeze([...reasons]), evidence });
}
