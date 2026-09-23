import { makeScore } from "./scale.js";

/** Board B presentation only: selection remains internally 0..1 to preserve its thresholds. */
export function scoreSymbolCandidate(candidate) {
  const reasons = candidate?.reasons?.length ? candidate.reasons : ["No selection evidence was available."];
  return makeScore({
    score: candidate?.eligible ? Number((Number(candidate.score) * 10).toFixed(1)) : null,
    confidence: candidate?.unmeasured?.length ? "low" : "medium",
    reasons,
    evidence: candidate?.evidence ?? []
  });
}

export function presentSymbolSelection(result, universe) {
  const present = (candidate) => Object.freeze({
    ...candidate,
    board: scoreSymbolCandidate(candidate),
    forwardTestOnly: Boolean(universe.forwardTestOnly)
  });
  return Object.freeze({
    ...result,
    recommended: Object.freeze(result.recommended.map(present)),
    excluded: Object.freeze(result.excluded.map(present)),
    universe: Object.freeze({
      source: universe.source,
      forwardTestOnly: Boolean(universe.forwardTestOnly),
      survivorshipWarning: universe.survivorshipWarning ?? null,
      fallback: Boolean(universe.fallback),
      size: universe.symbols.length
    }),
    caption: "Board B — tradeability and measurement quality, not expected return."
  });
}
