/**
 * Adapter — lets feature-declaring algorithms run inside the EXISTING Stockbot
 * server without modifying it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────
 * The current loader (server/index.js:1126 `loadAlgorithms`) imports every
 * `.js` file in `algorithms/` and calls `signal(context)` synchronously, once
 * per bar, with no `features` key. Fetching news inside `signal()` is
 * impossible: it is sync, and it runs thousands of times per backtest.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE APPROACH
 * ─────────────────────────────────────────────────────────────────────────────
 * `prepare()` resolves and aligns features ahead of time, then returns a plain
 * algorithm whose `signal()` closes over the resolved arrays. The result is
 * shape-compatible with the legacy loader — same keys, sync signal, no new
 * context requirements — so it drops into `algorithms/` and runs.
 *
 * Two honest caveats, because this shim cannot fix the engine it plugs into:
 *
 *   1. The legacy engine still fills at the signal bar's own close
 *      (server/index.js:1020, finding C2). Any result it produces for these
 *      algorithms is optimistic. Use `training/walk-forward.js` for numbers you
 *      intend to believe; use this adapter to see markers on the chart.
 *   2. Features are aligned to the bar series passed to `prepare()`. If the
 *      legacy engine later runs the algorithm over a DIFFERENT window, indices
 *      no longer correspond. `prepare()` therefore stamps the window and
 *      `signal()` refuses to use stale features rather than reading the wrong
 *      bar — silence beats a plausible wrong answer.
 */

import { resolveFeatures } from "./feeds/index.js";
import { toEpochMs } from "./feeds/align.js";

/**
 * Bind an algorithm's declared features to a concrete bar series.
 *
 * @param {object} params
 * @param {object} params.algorithm   feature-declaring algorithm
 * @param {Array<{time: number|string}>} params.bars
 * @param {string} params.symbol
 * @param {object} [params.env]
 * @returns {Promise<{algorithm: object, report: object[]}>} legacy-compatible algorithm
 */
export async function prepare({ algorithm, bars, symbol, env = process.env }) {
  const { features, report } = await resolveFeatures({
    algorithm,
    bars,
    symbol,
    mode: "backtest",
    env
  });

  const fingerprint = {
    length: bars.length,
    startMs: toEpochMs(bars[0].time ?? bars[0].t, "bars[0].time"),
    endMs: toEpochMs(bars.at(-1).time ?? bars.at(-1).t, "bars[last].time"),
    symbol: String(symbol).toUpperCase()
  };

  let warnedStale = false;

  const bound = {
    name: algorithm.name,
    author: algorithm.author,
    description: algorithm.description,
    params: algorithm.params,

    init(context) {
      return typeof algorithm.init === "function"
        ? algorithm.init({ ...context, features })
        : {};
    },

    signal(context) {
      // Verify the engine is running the same window we aligned against.
      const sameWindow =
        Array.isArray(context.bars) &&
        context.bars.length === fingerprint.length &&
        toEpochMs(context.bars[0].time ?? context.bars[0].t, "bar time") === fingerprint.startMs;

      if (!sameWindow) {
        if (!warnedStale) {
          warnedStale = true;
          process.emitWarning(
            `${algorithm.name}: features were aligned to a ${fingerprint.length}-bar window ` +
              `but the engine supplied ${context.bars?.length}. Feature values would refer to ` +
              `the wrong bars, so the strategy will stay flat. Re-run prepare() for this window.`,
            "StaleFeatureWarning"
          );
        }
        return null;
      }

      const view = {};
      for (const [name, series] of Object.entries(features)) view[name] = series[context.index];
      return algorithm.signal({ ...context, features: view, featureSeries: features });
    }
  };

  return { algorithm: bound, report, fingerprint };
}

/**
 * Static-analysis helper: does this algorithm need the feature layer?
 *
 * The legacy loader can call this to decide whether an algorithm is safe to run
 * directly, or needs `prepare()` first. An algorithm declaring features that is
 * loaded raw will read `undefined` and — because news-drift gates on
 * `news.count` — silently never trade, which looks like a broken strategy
 * rather than a missing setup step.
 */
export function needsPreparation(algorithm) {
  return Object.keys(algorithm?.features ?? {}).length > 0;
}

/**
 * A guard to drop into a raw-loaded feature algorithm so the failure is loud.
 * @param {object} algorithm
 */
export function assertPrepared(algorithm) {
  if (needsPreparation(algorithm)) {
    throw new Error(
      `${algorithm.name ?? "algorithm"} declares external features ` +
        `(${Object.keys(algorithm.features).join(", ")}) and must be bound with ` +
        `stockbot-alpha/adapter.js#prepare() before running. Loading it directly ` +
        `would give it undefined feature values.`
    );
  }
}
