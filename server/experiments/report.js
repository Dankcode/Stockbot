/**
 * Turns raw arm results into a verdict.
 *
 * The rules here are the procedure in docs/CONTROL_GROUP.md, executed instead of read.
 * They are deliberately ordered as a gauntlet with early exits, because that is how the
 * document says to run it: a strategy that loses to cash is not interesting for having
 * beaten a random control, and reporting both numbers with equal weight invites the
 * reader to pick the flattering one.
 *
 * Nothing here is a recommendation to trade. Every verdict is a statement about whether
 * a measured difference survived its own null hypothesis on one symbol over one window.
 */

/** Percentile of `value` within `distribution`, 0-100, null for an empty distribution. */
export function percentileOf(value, distribution) {
  const finite = distribution.filter((entry) => Number.isFinite(entry));
  if (finite.length === 0 || !Number.isFinite(value)) return null;
  const below = finite.filter((entry) => entry < value).length;
  return Math.round((below / finite.length) * 100);
}

export function quantiles(distribution) {
  const sorted = distribution.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))];
  return Object.freeze({
    count: sorted.length,
    min: sorted[0],
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: sorted[sorted.length - 1]
  });
}

const VERDICTS = Object.freeze({
  FAILS_FLOOR: "fails-floor",
  BELOW_PASSIVE: "below-passive",
  NO_TIMING_EDGE: "no-timing-edge",
  INSIDE_NOISE: "inside-noise",
  INSUFFICIENT_EVIDENCE: "insufficient-evidence",
  WORTH_RECORDING: "worth-recording",
  INCOMPLETE: "incomplete"
});

export { VERDICTS };

/**
 * Exposure gap beyond which the fixed-interval control is not actually exposure-matched
 * and the comparison is measuring time-in-market rather than timing. Ten percentage
 * points is a judgement call; it is surfaced as a warning, never as a silent pass.
 */
const EXPOSURE_TOLERANCE_POINTS = 10;

/** Percentile a strategy must clear against the random distribution to escape "noise". */
const NOISE_PERCENTILE = 90;

/**
 * Closed round trips below which no verdict can be positive.
 *
 * Found by running the real automation: a strategy with two closed trades cleared every
 * control on a 140-bar window and was reported as "worth recording" with a warning
 * underneath. A warning next to a favourable verdict is not a brake — the verdict is
 * what gets read, quoted and acted on. Sharpe, win rate, profit factor and a percentile
 * rank are all meaningless at n=2, so too few trades now blocks the positive verdict
 * outright rather than annotating it.
 */
const MIN_CLOSED_TRADES = 5;

function metricsOf(entry) {
  return entry?.metrics ?? entry?.result?.metrics ?? entry?.strategy?.metrics ?? null;
}

function isRandomControl(arm) {
  return Object.hasOwn(arm.params ?? {}, "seed");
}

function isPassiveControl(arm) {
  return arm.role === "benchmark" || /buy-and-hold/i.test(arm.algorithmId);
}

/**
 * Summarizes one strategy against its own controls. `resultsByArm` is keyed on the arm
 * `key` produced by plan.js, so shared controls are read by every group that named them.
 */
export function summarizeGroup({ group, resultsByArm }) {
  const strategyEntry = resultsByArm.get(group.strategy.key);
  const strategy = metricsOf(strategyEntry);
  const warnings = [];
  const failures = [];

  if (!strategy) {
    return Object.freeze({
      strategy: group.strategy,
      verdict: VERDICTS.INCOMPLETE,
      reason: strategyEntry?.error ?? "The strategy arm produced no metrics.",
      metrics: null,
      controls: Object.freeze([]),
      warnings: Object.freeze([]),
      randomDistribution: null,
      percentile: null
    });
  }

  const controls = [];
  const randomReturns = [];
  let passive = null;
  let exposureMatched = null;

  for (const arm of group.controls) {
    const entry = resultsByArm.get(arm.key);
    const metrics = metricsOf(entry);
    if (!metrics) {
      failures.push(`${arm.id}: ${entry?.error ?? "no metrics"}`);
      continue;
    }
    if (isRandomControl(arm)) {
      randomReturns.push(Number(metrics.returnPercent));
      continue;
    }
    controls.push(Object.freeze({ arm, metrics }));
    if (isPassiveControl(arm)) passive = metrics;
    // The last non-passive, non-random control is treated as the exposure-matched one.
    // In every shipped pairing that is fixed-interval; a custom pairing that names two
    // gets the later one, and the exposure warning below catches a bad choice.
    else exposureMatched = metrics;
  }

  const distribution = quantiles(randomReturns);
  const percentile = percentileOf(Number(strategy.returnPercent), randomReturns);

  if (failures.length > 0) {
    warnings.push(`${failures.length} control arm(s) failed: ${failures.slice(0, 3).join("; ")}`);
  }
  if (randomReturns.length > 0 && randomReturns.length < 10) {
    warnings.push(`Only ${randomReturns.length} random seeds — CONTROL_GROUP.md asks for at least 10, ideally 20.`);
  }
  if (exposureMatched && Number.isFinite(Number(strategy.exposurePercent))) {
    const gap = Math.abs(Number(strategy.exposurePercent) - Number(exposureMatched.exposurePercent));
    if (gap > EXPOSURE_TOLERANCE_POINTS) {
      warnings.push(
        `Exposure gap ${gap.toFixed(1)}pp: strategy ${Number(strategy.exposurePercent).toFixed(1)}% vs control ` +
        `${Number(exposureMatched.exposurePercent).toFixed(1)}%. Tune entryEveryBars/holdBars before believing this row.`
      );
    }
  }
  if (strategy.openPosition) {
    warnings.push("The strategy ended the window holding a position, marked to the final close rather than sold.");
  }
  if (Number(strategy.closedTradeCount ?? 0) < 5) {
    warnings.push(`${strategy.closedTradeCount ?? 0} closed trades — too few for the metrics to mean much.`);
  }

  // The gauntlet, in the order CONTROL_GROUP.md prescribes.
  let verdict = VERDICTS.WORTH_RECORDING;
  let reason = "Beat every control it was measured against.";
  if (!(Number(strategy.returnPercent) > 0)) {
    verdict = VERDICTS.FAILS_FLOOR;
    reason = "Lost to cash. Nothing below this line can rescue it.";
  } else if (passive && Number(strategy.sharpe) <= Number(passive.sharpe)) {
    verdict = VERDICTS.BELOW_PASSIVE;
    reason =
      `Risk-adjusted return did not beat same-asset buy-and-hold ` +
      `(Sharpe ${Number(strategy.sharpe).toFixed(2)} vs ${Number(passive.sharpe).toFixed(2)}).`;
  } else if (exposureMatched && Number(strategy.returnPercent) <= Number(exposureMatched.returnPercent)) {
    verdict = VERDICTS.NO_TIMING_EDGE;
    reason =
      `An exposure-matched control that ignores price returned more ` +
      `(${Number(exposureMatched.returnPercent).toFixed(2)}% vs ${Number(strategy.returnPercent).toFixed(2)}%). ` +
      "The rules are not picking moments.";
  } else if (percentile !== null && percentile < NOISE_PERCENTILE) {
    verdict = VERDICTS.INSIDE_NOISE;
    reason =
      `${percentile}th percentile against ${randomReturns.length} information-free seeds. ` +
      "Under ~90 is inside the draw variance.";
  } else if (percentile === null) {
    verdict = VERDICTS.INCOMPLETE;
    reason = "No random control distribution was produced, so the null hypothesis was never tested.";
  } else if (Number(strategy.closedTradeCount ?? 0) < MIN_CLOSED_TRADES) {
    verdict = VERDICTS.INSUFFICIENT_EVIDENCE;
    reason =
      `Cleared every control, but on ${strategy.closedTradeCount ?? 0} closed trades. ` +
      `Sharpe, win rate and percentile rank do not mean anything below ${MIN_CLOSED_TRADES} round trips — ` +
      "widen the window or loosen the entry before reading this as a result.";
  }

  return Object.freeze({
    strategy: group.strategy,
    verdict,
    reason,
    metrics: strategy,
    passive,
    exposureMatched,
    controls: Object.freeze(controls),
    randomDistribution: distribution,
    percentile,
    // Drop the trade-count warning when it has already become the verdict; the same
    // sentence twice reads as a rendering bug rather than as emphasis.
    warnings: Object.freeze(
      verdict === VERDICTS.INSUFFICIENT_EVIDENCE
        ? warnings.filter((warning) => !warning.includes("closed trades"))
        : warnings
    )
  });
}

export function summarizeExperiment({ plan, results }) {
  const resultsByArm = results instanceof Map ? results : new Map(Object.entries(results ?? {}));
  const groups = plan.groups.map((group) => summarizeGroup({ group, resultsByArm }));
  const executed = [...resultsByArm.values()].filter((entry) => metricsOf(entry)).length;
  return Object.freeze({
    symbol: plan.symbol,
    range: plan.range,
    createdAt: plan.createdAt,
    armCount: plan.arms.length,
    executedCount: executed,
    failedCount: plan.arms.length - executed,
    groups: Object.freeze(groups),
    /** A single line an operator can act on without reading the table. */
    headline: headlineFor(groups)
  });
}

function headlineFor(groups) {
  const promising = groups.filter((group) => group.verdict === VERDICTS.WORTH_RECORDING);
  if (promising.length === 0) {
    return "No strategy cleared its own control group. Nothing here is evidence of an edge.";
  }
  const names = promising.map((group) => group.strategy.id).join(", ");
  return `${promising.length} of ${groups.length} cleared every control: ${names}. One symbol over one window is still an anecdote — repeat on unrelated symbols before calling it a strategy.`;
}

/* ---------------------------------------------------------------- rendering */

function fixed(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function pad(value, width, right = false) {
  // Truncate rather than overflow. An arm id like
  // "core-controls/fixed-interval#entryEveryBars=20,holdBars=8" is 57 characters, and
  // letting it run long pushes every numeric column of that row out of alignment.
  let text = String(value);
  if (text.length > width) text = `${text.slice(0, width - 2)}… `;
  return right ? text.padStart(width) : text.padEnd(width);
}

const ARM_COLUMN = 42;
const PCTILE_COLUMN = 9;

const VERDICT_LABEL = Object.freeze({
  [VERDICTS.WORTH_RECORDING]: "clears controls",
  [VERDICTS.INSUFFICIENT_EVIDENCE]: "too few trades",
  [VERDICTS.INSIDE_NOISE]: "inside noise",
  [VERDICTS.NO_TIMING_EDGE]: "no timing edge",
  [VERDICTS.BELOW_PASSIVE]: "below passive",
  [VERDICTS.FAILS_FLOOR]: "fails floor",
  [VERDICTS.INCOMPLETE]: "incomplete"
});

export function renderExperimentTable(report) {
  const lines = [];
  const head =
    pad("arm", ARM_COLUMN) + pad("return%", 10, true) + pad("sharpe", 9, true) +
    pad("maxDD%", 9, true) + pad("expo%", 8, true) + pad("trades", 8, true) + pad("pctile", PCTILE_COLUMN, true);

  lines.push(`\nExperiment — ${report.symbol} over ${report.range}`);
  lines.push(`${report.executedCount}/${report.armCount} arms executed${report.failedCount ? `, ${report.failedCount} failed` : ""}`);

  for (const group of report.groups) {
    lines.push(`\n── ${group.strategy.id}  [${VERDICT_LABEL[group.verdict] ?? group.verdict}] ${"─".repeat(Math.max(0, 40 - group.strategy.id.length))}`);
    lines.push(head);
    if (group.metrics) {
      lines.push(
        pad(group.strategy.id, ARM_COLUMN) +
        pad(fixed(group.metrics.returnPercent), 10, true) +
        pad(fixed(group.metrics.sharpe), 9, true) +
        pad(fixed(group.metrics.maxDrawdown), 9, true) +
        pad(fixed(group.metrics.exposurePercent, 1), 8, true) +
        pad(group.metrics.tradeCount ?? "—", 8, true) +
        pad(group.percentile ?? "—", PCTILE_COLUMN, true)
      );
    }
    for (const control of group.controls) {
      lines.push(
        pad(`· ${control.arm.id}`, ARM_COLUMN) +
        pad(fixed(control.metrics.returnPercent), 10, true) +
        pad(fixed(control.metrics.sharpe), 9, true) +
        pad(fixed(control.metrics.maxDrawdown), 9, true) +
        pad(fixed(control.metrics.exposurePercent, 1), 8, true) +
        pad(control.metrics.tradeCount ?? "—", 8, true) +
        pad("—", PCTILE_COLUMN, true)
      );
    }
    if (group.randomDistribution) {
      const d = group.randomDistribution;
      lines.push(
        pad("· random control (median)", ARM_COLUMN) +
        pad(fixed(d.median), 10, true) +
        pad("—", 9, true) + pad("—", 9, true) + pad("—", 8, true) + pad("—", 8, true) +
        pad(`${d.count} seeds`, PCTILE_COLUMN, true)
      );
      lines.push(`${pad("", ARM_COLUMN)}${pad(`${fixed(d.min)} … ${fixed(d.max)}`, 28, true)}   full range across seeds`);
    }
    lines.push(`  → ${group.reason}`);
    for (const warning of group.warnings) lines.push(`  ! ${warning}`);
  }

  lines.push(`\n${report.headline}`);
  return lines.join("\n");
}
