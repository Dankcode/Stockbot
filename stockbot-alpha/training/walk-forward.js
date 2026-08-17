/**
 * Walk-forward validation — the training technique everything else depends on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM IT SOLVES
 * ─────────────────────────────────────────────────────────────────────────────
 * Right now, tuning a strategy in Stockbot means editing `params`, re-running
 * the backtest over the same window, and keeping whatever number went up. Do
 * that a dozen times and you have not found an edge — you have memorized the
 * price history. The result will be excellent in the backtest and mediocre
 * live, and nothing in the current tooling can tell you which you are looking
 * at.
 *
 * Walk-forward fixes that by never scoring a parameter set on data used to
 * choose it:
 *
 *     |── train ──|─ test ─|
 *          |── train ──|─ test ─|
 *               |── train ──|─ test ─|
 *
 * For each fold, search parameters on the train slice only, then run the winner
 * once on the test slice it has never seen. Stitch the test slices together and
 * you get an out-of-sample equity curve — the closest honest estimate of how
 * the strategy would actually have performed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NUMBER THAT MATTERS
 * ─────────────────────────────────────────────────────────────────────────────
 * `degradation` — in-sample return minus out-of-sample return. Large positive
 * degradation means the parameter search is fitting noise. That single figure
 * is more informative than any backtest return, and it is the thing to watch
 * when deciding whether a strategy is worth running.
 *
 * Rules of thumb, not laws: degradation under ~30% of in-sample return is
 * tolerable; a strategy whose out-of-sample Sharpe is negative while in-sample
 * is strongly positive is overfit regardless of what the return says.
 */

import { runBacktest, runBuyAndHold, runCashControl } from "./backtest.js";
import { computeMetrics, METRIC_META } from "./metrics.js";
import { resolveFeatures } from "../feeds/index.js";

/**
 * Build rolling or anchored folds.
 *
 * @param {number} total number of bars
 * @param {object} options
 * @param {number} options.trainBars
 * @param {number} options.testBars
 * @param {number} [options.stepBars] defaults to testBars (non-overlapping tests)
 * @param {"rolling"|"anchored"} [options.mode="rolling"]
 * @param {number} [options.embargoBars=0] gap between train and test
 * @returns {Array<{fold: number, train: [number, number], test: [number, number]}>}
 */
export function buildFolds(total, { trainBars, testBars, stepBars, mode = "rolling", embargoBars = 0 }) {
  if (!Number.isInteger(trainBars) || trainBars < 10) {
    throw new RangeError("buildFolds: trainBars must be an integer >= 10");
  }
  if (!Number.isInteger(testBars) || testBars < 3) {
    throw new RangeError("buildFolds: testBars must be an integer >= 3");
  }
  const step = stepBars ?? testBars;
  const folds = [];

  let trainStart = 0;
  let trainEnd = trainBars;

  while (trainEnd + embargoBars + testBars <= total) {
    const testStart = trainEnd + embargoBars;
    folds.push({
      fold: folds.length,
      train: [mode === "anchored" ? 0 : trainStart, trainEnd],
      test: [testStart, testStart + testBars]
    });
    trainStart += step;
    trainEnd += step;
  }

  if (folds.length === 0) {
    throw new Error(
      `buildFolds: ${total} bars is not enough for trainBars=${trainBars} + ` +
        `embargoBars=${embargoBars} + testBars=${testBars}. Need at least ` +
        `${trainBars + embargoBars + testBars}.`
    );
  }
  return folds;
}

/**
 * Cartesian product of a parameter grid.
 *
 * @param {Record<string, Array<number|string|boolean>>} grid
 * @returns {Array<Record<string, any>>}
 */
export function expandGrid(grid) {
  const keys = Object.keys(grid ?? {});
  if (keys.length === 0) return [{}];

  let combos = [{}];
  for (const key of keys) {
    const values = grid[key];
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error(`expandGrid: "${key}" must be a non-empty array`);
    }
    const next = [];
    for (const combo of combos) {
      for (const value of values) next.push({ ...combo, [key]: value });
    }
    combos = next;
  }
  return combos;
}

/** Objective functions for parameter selection. */
export const OBJECTIVES = {
  /** Risk-adjusted. The sane default — return alone rewards taking more risk. */
  sharpe: (m) => (m.sharpe == null ? -Infinity : m.sharpe),
  sortino: (m) => (m.sortino == null ? -Infinity : m.sortino),
  return: (m) => m.returnPercent ?? -Infinity,
  calmar: (m) => (m.calmar == null ? -Infinity : m.calmar),
  /**
   * Return penalized by drawdown. Useful when Sharpe is unstable because the
   * strategy trades rarely — a handful of trades makes Sharpe close to noise.
   */
  returnPerDrawdown: (m) => {
    if (m.returnPercent == null) return -Infinity;
    return m.returnPercent / Math.max(1, m.maxDrawdown ?? 1);
  }
};

/**
 * Slice features alongside bars so a fold's feature arrays stay index-aligned.
 * @returns {Record<string, any[]>}
 */
function sliceFeatures(features, start, end) {
  const out = {};
  for (const [name, series] of Object.entries(features)) out[name] = series.slice(start, end);
  return out;
}

/**
 * Run walk-forward validation.
 *
 * @param {object} params
 * @param {import("./fill-model.js").Bar[]} params.bars
 * @param {object} params.algorithm
 * @param {string} params.symbol
 * @param {Record<string, any[]>} [params.features] prefetched; resolved if omitted
 * @param {Record<string, any[]>} [params.grid] parameter search space
 * @param {keyof OBJECTIVES|((m: object) => number)} [params.objective="sharpe"]
 * @param {number} params.trainBars
 * @param {number} params.testBars
 * @param {number} [params.stepBars]
 * @param {"rolling"|"anchored"} [params.mode="rolling"]
 * @param {number} [params.embargoBars=0]
 * @param {number} [params.startingCash=100000]
 * @param {object} [params.fillModel]
 * @param {number} [params.minTradesPerFold=1] reject params that barely trade
 * @returns {Promise<object>}
 */
export async function walkForward({
  bars,
  algorithm,
  symbol,
  features,
  grid,
  objective = "sharpe",
  trainBars,
  testBars,
  stepBars,
  mode = "rolling",
  embargoBars = 0,
  startingCash = 100_000,
  fillModel = {},
  minTradesPerFold = 1,
  env = process.env
}) {
  const score = typeof objective === "function" ? objective : OBJECTIVES[objective];
  if (typeof score !== "function") {
    throw new Error(
      `walkForward: unknown objective "${objective}". Options: ${Object.keys(OBJECTIVES).join(", ")}`
    );
  }

  // Resolve features once over the FULL series, then slice per fold. Resolving
  // per fold would refetch and, worse, could align differently at the seams.
  let resolvedFeatures = features;
  let featureReport = [];
  if (!resolvedFeatures) {
    const resolved = await resolveFeatures({ algorithm, bars, symbol, mode: "backtest", env });
    resolvedFeatures = resolved.features;
    featureReport = resolved.report;
  }

  const folds = buildFolds(bars.length, { trainBars, testBars, stepBars, mode, embargoBars });
  const combos = expandGrid(grid);
  const foldResults = [];

  for (const fold of folds) {
    const [trainStart, trainEnd] = fold.train;
    const [testStart, testEnd] = fold.test;
    const trainBarsSlice = bars.slice(trainStart, trainEnd);
    const testBarsSlice = bars.slice(testStart, testEnd);
    const trainFeatures = sliceFeatures(resolvedFeatures, trainStart, trainEnd);
    const testFeatures = sliceFeatures(resolvedFeatures, testStart, testEnd);

    // ─── Search: train slice only ────────────────────────────────────────
    let best = null;
    const searched = [];
    for (const combo of combos) {
      let result;
      try {
        result = runBacktest({
          bars: trainBarsSlice,
          algorithm,
          features: trainFeatures,
          params: combo,
          startingCash,
          fillModel
        });
      } catch (error) {
        searched.push({ params: combo, error: error.message, score: -Infinity });
        continue;
      }

      // A parameter set that produced almost no trades has a meaningless score;
      // admitting it lets the search "win" by doing nothing.
      const tradeCount = result.metrics.closedTradeCount ?? 0;
      const eligible = tradeCount >= minTradesPerFold;
      const value = eligible ? score(result.metrics) : -Infinity;

      searched.push({
        params: combo,
        score: Number.isFinite(value) ? Number(value.toFixed(4)) : null,
        trades: tradeCount,
        returnPercent: result.metrics.returnPercent,
        sharpe: result.metrics.sharpe,
        eligible
      });

      if (!best || value > best.value) best = { value, params: combo, result };
    }

    if (!best || !Number.isFinite(best.value)) {
      foldResults.push({
        ...fold,
        skipped: true,
        reason: `no parameter set produced at least ${minTradesPerFold} closed trade(s) in training`,
        searched
      });
      continue;
    }

    // ─── Score: test slice, chosen params, run exactly once ──────────────
    const testResult = runBacktest({
      bars: testBarsSlice,
      algorithm,
      features: testFeatures,
      params: best.params,
      startingCash,
      fillModel
    });

    const control = runBuyAndHold({ bars: testBarsSlice, startingCash, fillModel });

    foldResults.push({
      ...fold,
      skipped: false,
      chosenParams: best.params,
      inSample: best.result.metrics,
      outOfSample: testResult.metrics,
      control: control.metrics,
      excessVsControl: round(
        (testResult.metrics.returnPercent ?? 0) - (control.metrics.returnPercent ?? 0),
        2
      ),
      trades: testResult.trades,
      equityCurve: testResult.equityCurve,
      searched
    });
  }

  const scored = foldResults.filter((f) => !f.skipped);
  if (scored.length === 0) {
    return {
      symbol,
      algorithm: algorithm.name ?? "algorithm",
      folds: foldResults,
      featureReport,
      summary: null,
      verdict: {
        overfit: null,
        note: "Every fold was skipped — the strategy did not trade enough to evaluate."
      }
    };
  }

  // ─── Stitch out-of-sample equity into one continuous curve ─────────────
  // Each fold restarts at `startingCash`, so compound the fold returns rather
  // than concatenating raw equity values.
  const stitched = [{ at: scored[0].equityCurve[0].at, equity: startingCash }];
  let running = startingCash;
  for (const fold of scored) {
    const foldStart = fold.equityCurve[0].equity;
    for (const point of fold.equityCurve.slice(1)) {
      stitched.push({ at: point.at, equity: running * (point.equity / foldStart) });
    }
    running *= fold.outOfSample.finalEquity / startingCash;
  }

  const allTrades = scored.flatMap((f) => f.trades);
  const oosMetrics = computeMetrics({
    equityCurve: stitched,
    trades: allTrades,
    startingCash,
    totalBars: stitched.length - 1,
    barsInPosition: 0
  });

  const avg = (pick) => {
    const values = scored.map(pick).filter((v) => v != null && Number.isFinite(v));
    return values.length ? round(values.reduce((s, v) => s + v, 0) / values.length, 2) : null;
  };

  const inSampleReturn = avg((f) => f.inSample.returnPercent);
  const outOfSampleReturn = avg((f) => f.outOfSample.returnPercent);
  const degradation =
    inSampleReturn != null && outOfSampleReturn != null
      ? round(inSampleReturn - outOfSampleReturn, 2)
      : null;

  const positiveFolds = scored.filter((f) => (f.outOfSample.returnPercent ?? 0) > 0).length;
  const beatControlFolds = scored.filter((f) => (f.excessVsControl ?? 0) > 0).length;

  return {
    symbol,
    algorithm: algorithm.name ?? "algorithm",
    config: { trainBars, testBars, stepBars: stepBars ?? testBars, mode, embargoBars, objective: String(objective) },
    folds: foldResults,
    featureReport,
    summary: {
      foldCount: scored.length,
      skippedFolds: foldResults.length - scored.length,
      avgInSampleReturn: inSampleReturn,
      avgOutOfSampleReturn: outOfSampleReturn,
      degradation,
      avgOutOfSampleSharpe: avg((f) => f.outOfSample.sharpe),
      avgInSampleSharpe: avg((f) => f.inSample.sharpe),
      avgExcessVsControl: avg((f) => f.excessVsControl),
      positiveFolds,
      positiveFoldRate: round((positiveFolds / scored.length) * 100, 1),
      beatControlFolds,
      beatControlRate: round((beatControlFolds / scored.length) * 100, 1),
      /** Parameter stability: how often the search picked the same values. */
      paramStability: paramStability(scored),
      stitchedOutOfSample: oosMetrics
    },
    verdict: verdict({ degradation, inSampleReturn, outOfSampleReturn, scored })
  };
}

/**
 * How consistently the parameter search landed on the same values.
 *
 * Unstable parameters are a strong overfitting tell — if fold 3 wants ema=9 and
 * fold 4 wants ema=34, the search is chasing noise, and no single value will
 * work going forward.
 */
function paramStability(scored) {
  const keys = new Set(scored.flatMap((f) => Object.keys(f.chosenParams ?? {})));
  const out = {};
  for (const key of keys) {
    const counts = new Map();
    for (const fold of scored) {
      const value = String(fold.chosenParams?.[key]);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    out[key] = {
      modal: sorted[0][0],
      modalShare: round((sorted[0][1] / scored.length) * 100, 1),
      distinctValues: sorted.length
    };
  }
  return out;
}

function verdict({ degradation, inSampleReturn, outOfSampleReturn, scored }) {
  const notes = [];
  let overfit = false;

  if (degradation != null && inSampleReturn != null && inSampleReturn > 0) {
    const ratio = degradation / inSampleReturn;
    if (ratio > 0.7) {
      overfit = true;
      notes.push(
        `Out-of-sample return is ${round(ratio * 100, 0)}% below in-sample. ` +
          `The parameter search is fitting noise, not signal.`
      );
    } else if (ratio > 0.3) {
      notes.push(
        `Moderate degradation (${round(ratio * 100, 0)}% of in-sample return lost out-of-sample). ` +
          `Consider a coarser parameter grid or fewer tunable parameters.`
      );
    }
  }

  const oosSharpes = scored.map((f) => f.outOfSample.sharpe).filter((v) => v != null);
  const isSharpes = scored.map((f) => f.inSample.sharpe).filter((v) => v != null);
  if (oosSharpes.length && isSharpes.length) {
    const oosAvg = oosSharpes.reduce((s, v) => s + v, 0) / oosSharpes.length;
    const isAvg = isSharpes.reduce((s, v) => s + v, 0) / isSharpes.length;
    if (isAvg > 0.5 && oosAvg < 0) {
      overfit = true;
      notes.push(
        `In-sample Sharpe is positive (${round(isAvg, 2)}) but out-of-sample is negative ` +
          `(${round(oosAvg, 2)}). This is the clearest overfitting signature there is.`
      );
    }
  }

  const unstable = Object.entries(paramStability(scored)).filter(([, s]) => s.modalShare < 40);
  if (unstable.length > 0) {
    notes.push(
      `Unstable parameters: ${unstable.map(([k]) => k).join(", ")} — the search picked a ` +
        `different value in most folds, so no single setting is likely to hold up.`
    );
  }

  if (outOfSampleReturn != null && outOfSampleReturn <= 0) {
    notes.push(`Average out-of-sample return is ${round(outOfSampleReturn, 2)}%. No demonstrated edge.`);
  }

  if (notes.length === 0) {
    notes.push("No overfitting red flags. Degradation is within tolerance and parameters are stable.");
  }

  return { overfit, notes };
}

function round(value, places) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Render a walk-forward result as a text report. */
export function formatReport(result) {
  const lines = [];
  const s = result.summary;
  lines.push(`Walk-forward — ${result.algorithm} on ${result.symbol}`);
  lines.push("=".repeat(66));

  if (!s) {
    lines.push(result.verdict.note);
    return lines.join("\n");
  }

  lines.push(
    `Folds: ${s.foldCount}${s.skippedFolds ? ` (${s.skippedFolds} skipped)` : ""}   ` +
      `train=${result.config.trainBars} test=${result.config.testBars} ` +
      `mode=${result.config.mode} objective=${result.config.objective}`
  );
  lines.push("");
  lines.push(`  In-sample return  (avg): ${fmt(s.avgInSampleReturn)}%`);
  lines.push(`  Out-of-sample     (avg): ${fmt(s.avgOutOfSampleReturn)}%`);
  lines.push(`  Degradation            : ${fmt(s.degradation)} pp   <-- the number that matters`);
  lines.push(`  OOS Sharpe        (avg): ${fmt(s.avgOutOfSampleSharpe)}`);
  lines.push(`  vs buy & hold     (avg): ${fmt(s.avgExcessVsControl)} pp`);
  lines.push(`  Profitable folds       : ${s.positiveFolds}/${s.foldCount} (${fmt(s.positiveFoldRate)}%)`);
  lines.push(`  Beat control           : ${s.beatControlFolds}/${s.foldCount} (${fmt(s.beatControlRate)}%)`);
  lines.push("");
  lines.push(`  Stitched OOS: return ${fmt(s.stitchedOutOfSample.returnPercent)}%  ` +
    `maxDD ${fmt(s.stitchedOutOfSample.maxDrawdown)}%  ` +
    `Sharpe ${fmt(s.stitchedOutOfSample.sharpe)}  ` +
    `PF ${s.stitchedOutOfSample.profitFactor ?? "∞"}`);

  if (Object.keys(s.paramStability).length > 0) {
    lines.push("");
    lines.push("  Parameter stability:");
    for (const [key, stat] of Object.entries(s.paramStability)) {
      lines.push(
        `    ${key.padEnd(20)} modal=${String(stat.modal).padEnd(8)} ` +
          `${fmt(stat.modalShare)}% of folds, ${stat.distinctValues} distinct`
      );
    }
  }

  lines.push("");
  lines.push(`  VERDICT: ${result.verdict.overfit ? "OVERFIT" : "acceptable"}`);
  for (const note of result.verdict.notes) lines.push(`    - ${note}`);

  return lines.join("\n");
}

function fmt(value) {
  return value == null ? "—" : String(value);
}

export { METRIC_META, runBuyAndHold, runCashControl };
