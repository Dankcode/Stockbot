/**
 * Symbol selection for automated experiments.
 *
 * What this scores, and what it deliberately does not
 * ---------------------------------------------------
 * This ranks symbols by **how suitable they are for running a systematic experiment
 * on** — not by whether they are going to go up. Those are different questions, and
 * conflating them is how a screener turns into a tip sheet. A symbol scores well here
 * when it is liquid enough that the fill model is not fiction, volatile enough that a
 * timing rule has something to time, trending or ranging clearly enough that the
 * method family in question is applicable, and covered well enough by registered
 * research sources that the evidence trail is real.
 *
 * Every returned candidate therefore carries `reasons` (why it scored what it scored)
 * and `evidence` (which source said so, with the snapshot id). A recommendation with no
 * evidence array is a guess, and this module never emits one.
 *
 * Two hard rules, both of which cost recall on purpose:
 *
 * - **Gates run before scoring.** A symbol that fails a liquidity or price floor is
 *   excluded outright and reported as excluded, not scored down. A thin symbol with a
 *   beautiful trend is still untradeable at any realistic slippage.
 * - **Missing data is missing, never neutral.** A component with no data contributes
 *   nothing and shrinks the weight denominator, and the candidate is flagged. Scoring an
 *   absent sentiment reading as 0.5 invents a fact.
 *
 * Scoring is pure. Facts are gathered by the caller and injected; nothing here fetches,
 * scrapes, or reads configuration. That is what makes the ranking testable and what keeps
 * the scraping guardrails in one place (`server/research/`), where a source still cannot
 * be reached unless it is registered in RESEARCH_WEB_SOURCES_JSON.
 */
import { getRangeConfig } from "../../packages/shared/ranges.js";
import { band, ramp, scoreSeparation, weightedScore } from "../scoring/scale.js";

/**
 * History is gated on *coverage of the requested window*, not on an absolute bar count.
 *
 * The absolute version was a live bug: it required 250 bars, and no range Stockbot
 * supports can return that many — `RANGE_CONFIG` limits run 60, 78, 180, 60, 140, 80,
 * 140, so the ceiling across every range is 180. The gate excluded every symbol at every
 * range, `select` always returned an empty list, and `run --auto` always died with
 * `EXPERIMENT_NO_CANDIDATE`. The unit tests missed it because they injected 300-bar
 * arrays directly and never met a real range limit.
 *
 * Coverage asks the question that actually matters — "does this symbol have a full
 * history for the window we asked for?" — and is what catches a recent listing returning
 * 40 bars against a 140-bar request. `minBars` survives as an absolute floor below which
 * no indicator warmup is meaningful at any range.
 */
export const DEFAULT_GATES = Object.freeze({
  minPrice: 5,
  maxPrice: 10_000,
  minMedianDollarVolume: 20_000_000,
  minBars: 40,
  minHistoryCoverage: 0.8
});

export const DEFAULT_WEIGHTS = Object.freeze({
  liquidity: 0.30,
  volatility: 0.25,
  trendClarity: 0.25,
  researchCoverage: 0.20
});

function measured(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

/**
 * Facts shape (all optional; absent means "not measured", which is not the same as zero):
 *
 *   { symbol, price, medianDollarVolume, atrPercent, barCount,
 *     trendStrength,        // |close - SMA200| / SMA200, unsigned
 *     researchDocumentCount, researchSources: [{id, url, retrievedAt, snapshotId}] }
 */
export function scoreCandidate(facts, { weights = DEFAULT_WEIGHTS, gates = DEFAULT_GATES } = {}) {
  const symbol = String(facts?.symbol ?? "").trim().toUpperCase();
  const blockers = [];

  if (Number.isFinite(Number(facts?.price))) {
    if (Number(facts.price) < gates.minPrice) blockers.push(`price ${Number(facts.price).toFixed(2)} below the ${gates.minPrice} floor`);
    if (Number(facts.price) > gates.maxPrice) blockers.push(`price ${Number(facts.price).toFixed(2)} above the ${gates.maxPrice} ceiling`);
  } else {
    blockers.push("no price");
  }
  if (Number.isFinite(Number(facts?.medianDollarVolume))) {
    if (Number(facts.medianDollarVolume) < gates.minMedianDollarVolume) {
      blockers.push(`median dollar volume $${(Number(facts.medianDollarVolume) / 1e6).toFixed(1)}M below the $${(gates.minMedianDollarVolume / 1e6).toFixed(0)}M floor`);
    }
  } else {
    blockers.push("no volume data");
  }
  if (Number.isFinite(Number(facts?.barCount))) {
    if (Number(facts.barCount) < gates.minBars) {
      blockers.push(`only ${facts.barCount} bars of history, under the ${gates.minBars}-bar floor`);
    } else if (measured(facts?.expectedBars) && Number(facts.expectedBars) > 0) {
      const coverage = Number(facts.barCount) / Number(facts.expectedBars);
      if (coverage < gates.minHistoryCoverage) {
        blockers.push(
          `${facts.barCount} of ${facts.expectedBars} bars for the requested window ` +
          `(${Math.round(coverage * 100)}% coverage, floor ${Math.round(gates.minHistoryCoverage * 100)}%)`
        );
      }
    }
  } else {
    blockers.push("no bar history");
  }

  // Components. `null` means unmeasured and is excluded from the weighted average
  // rather than defaulted, so a candidate is never rewarded for missing data.
  const components = {
    // $20M/day is barely tradeable; $2B/day is unquestionably so. Log-scaled because the
    // difference between $20M and $200M matters far more than $2B versus $20B.
    liquidity: ramp(
      measured(facts?.medianDollarVolume) ? Math.log10(Math.max(1, Number(facts.medianDollarVolume))) : null,
      Math.log10(gates.minMedianDollarVolume),
      Math.log10(2e9)
    ),
    // ~2.75% daily ATR is the sweet spot: enough range for a timing rule to have
    // something to time, not so much that any sane stop is inside the noise. The band
    // reaches zero at 0.15% and 5.35% — a symbol that barely moves and one that gaps
    // wildly are both bad experiment subjects, for opposite reasons.
    volatility: band(facts?.atrPercent, 2.75, 2.6),
    // Distance from the long moving average, unsigned: a clean downtrend is as testable
    // as a clean uptrend, and a symbol pinned to its mean gives a trend method nothing.
    trendClarity: ramp(facts?.trendStrength, 0.02, 0.35),
    // Coverage, not sentiment. Whether an evidence trail exists, not what it says.
    researchCoverage: ramp(facts?.researchDocumentCount, 0, 12)
  };

  const weighted = weightedScore(components, weights);
  const score = weighted.score ?? 0;

  const reasons = [];
  if (components.liquidity !== null) {
    reasons.push(`liquidity ${(components.liquidity * 100).toFixed(0)}/100 — median $${(Number(facts.medianDollarVolume) / 1e6).toFixed(0)}M/day`);
  }
  if (components.volatility !== null) {
    reasons.push(`volatility ${(components.volatility * 100).toFixed(0)}/100 — ATR ${Number(facts.atrPercent).toFixed(2)}% of price`);
  }
  if (components.trendClarity !== null) {
    reasons.push(`trend clarity ${(components.trendClarity * 100).toFixed(0)}/100 — ${(Number(facts.trendStrength) * 100).toFixed(1)}% from its long average`);
  }
  if (components.researchCoverage !== null) {
    reasons.push(`research coverage ${(components.researchCoverage * 100).toFixed(0)}/100 — ${facts.researchDocumentCount ?? 0} archived documents`);
  }
  const unmeasured = weighted.unmeasured;
  if (unmeasured.length > 0) {
    reasons.push(`not measured: ${unmeasured.join(", ")} — score computed over the remaining weight only`);
  }

  return Object.freeze({
    symbol,
    score: Number(score.toFixed(4)),
    eligible: blockers.length === 0,
    blockers: Object.freeze(blockers),
    components: Object.freeze(components),
    unmeasured: Object.freeze(unmeasured),
    reasons: Object.freeze(reasons),
    evidence: Object.freeze([...(facts?.researchSources ?? [])])
  });
}

export function rankCandidates(candidateFacts, { weights, gates, limit = 10 } = {}) {
  const scored = (candidateFacts ?? []).map((facts) => scoreCandidate(facts, { weights, gates }));
  const eligible = scored.filter((candidate) => candidate.eligible).sort((a, b) => b.score - a.score);
  const excluded = scored.filter((candidate) => !candidate.eligible).sort((a, b) => b.score - a.score);
  return Object.freeze({
    recommended: Object.freeze(eligible.slice(0, Math.max(1, Math.trunc(limit)))),
    eligibleCount: eligible.length,
    excluded: Object.freeze(excluded),
    /** Confidence is a spread, not a feeling: how far the leader is clear of the pack. */
    separation: scoreSeparation(eligible.map((candidate) => candidate.score)).value
  });
}

/**
 * Derives the scoreable facts from one symbol's bar history. Kept here rather than in the
 * market service so the maths is unit-testable without a provider, and so the definition
 * of "volatility" used for selection is the same one the report explains.
 */
export function factsFromBars({ symbol, bars, research = {}, expectedBars = null }) {
  const closes = bars.map((bar) => Number(bar.close));
  const last = closes.at(-1);
  const window = Math.min(closes.length, 200);
  const longAverage = closes.slice(-window).reduce((sum, value) => sum + value, 0) / window;

  const dollarVolumes = bars.slice(-60).map((bar) => Number(bar.close) * Number(bar.volume ?? 0)).sort((a, b) => a - b);
  const medianDollarVolume = dollarVolumes.length > 0 ? dollarVolumes[Math.floor(dollarVolumes.length / 2)] : null;

  // True range over the last 14 bars, expressed as a percentage of price. This is the
  // selection-time volatility measure; the engine's ATR indicator is Wilder-smoothed and
  // used for stops, and the two are intentionally not shared.
  const recent = bars.slice(-15);
  let trueRangeSum = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const previousClose = Number(recent[index - 1].close);
    trueRangeSum += Math.max(
      Number(recent[index].high) - Number(recent[index].low),
      Math.abs(Number(recent[index].high) - previousClose),
      Math.abs(Number(recent[index].low) - previousClose)
    );
  }
  const atr = recent.length > 1 ? trueRangeSum / (recent.length - 1) : null;

  return Object.freeze({
    symbol: String(symbol).toUpperCase(),
    price: last,
    barCount: bars.length,
    expectedBars,
    medianDollarVolume,
    atrPercent: atr !== null && last > 0 ? (atr / last) * 100 : null,
    trendStrength: longAverage > 0 ? Math.abs(last - longAverage) / longAverage : null,
    researchDocumentCount: research.documentCount ?? null,
    researchSources: research.sources ?? []
  });
}

/**
 * Gathers facts for a universe and ranks it. `getBars` and `getResearch` are injected;
 * `getResearch` is optional and, when the research subsystem is unconfigured, simply
 * yields no coverage component rather than failing the run — an operator with no
 * registered sources should still get a liquidity and volatility ranking.
 */
export async function recommendSymbols({
  universe,
  getBars,
  getResearch = null,
  range = "1Y",
  weights,
  gates,
  limit = 5,
  concurrency = 4
}) {
  const symbols = [...new Set((universe ?? []).map((symbol) => String(symbol).trim().toUpperCase()).filter(Boolean))];
  // How many bars a full history for this range should contain. Coverage, not an
  // absolute count, is what the history gate compares against — see DEFAULT_GATES.
  let expectedBars = null;
  try {
    expectedBars = getRangeConfig(range).limit;
  } catch {
    expectedBars = null;
  }
  const facts = [];
  const errors = [];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= symbols.length) return;
      const symbol = symbols[index];
      try {
        const data = await getBars(symbol, range);
        const bars = data?.bars ?? data;
        if (!Array.isArray(bars) || bars.length === 0) throw new Error("no bars returned");
        let research = {};
        if (getResearch) {
          try {
            research = (await getResearch(symbol)) ?? {};
          } catch (cause) {
            // Research is additive. A scraper that is down must not remove a symbol from
            // consideration; it removes the coverage component and says so.
            errors.push({ symbol, stage: "research", message: cause?.message ?? String(cause) });
          }
        }
        facts.push(factsFromBars({ symbol, bars, research, expectedBars }));
      } catch (cause) {
        errors.push({ symbol, stage: "bars", message: cause?.message ?? String(cause) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
  const ranked = rankCandidates(facts, { weights, gates, limit });
  return Object.freeze({
    ...ranked,
    range,
    requested: symbols.length,
    scored: facts.length,
    errors: Object.freeze(errors)
  });
}

export function renderRecommendations(result) {
  const lines = [`\nSymbol suitability for systematic experiments — ${result.range} window`];
  lines.push(`${result.scored}/${result.requested} symbols scored, ${result.eligibleCount} passed the gates.\n`);
  lines.push(`${"symbol".padEnd(10)}${"score".padStart(8)}  reasons`);
  for (const candidate of result.recommended) {
    lines.push(`${candidate.symbol.padEnd(10)}${candidate.score.toFixed(3).padStart(8)}  ${candidate.reasons[0] ?? ""}`);
    for (const reason of candidate.reasons.slice(1)) lines.push(`${" ".repeat(20)}${reason}`);
    for (const source of candidate.evidence.slice(0, 3)) {
      lines.push(`${" ".repeat(20)}evidence: ${source.id ?? source.url ?? "source"}${source.retrievedAt ? ` @ ${new Date(source.retrievedAt).toISOString()}` : ""}`);
    }
  }
  if (result.excluded.length > 0) {
    lines.push(`\nExcluded (${result.excluded.length}):`);
    for (const candidate of result.excluded.slice(0, 10)) {
      lines.push(`  ${candidate.symbol.padEnd(8)} ${candidate.blockers.join("; ")}`);
    }
  }
  if (result.errors.length > 0) {
    lines.push(`\nData errors (${result.errors.length}):`);
    for (const error of result.errors.slice(0, 10)) lines.push(`  ${error.symbol} [${error.stage}] ${error.message}`);
  }
  if (result.separation !== null && result.separation < 0.05) {
    lines.push(`\nTop two are ${result.separation.toFixed(3)} apart — effectively tied. Treat the ordering as arbitrary and pick on grounds this score does not measure.`);
  }
  lines.push("\nThis ranks tradeability, not expected return. It is not a prediction that any of these will go up.");
  return lines.join("\n");
}
