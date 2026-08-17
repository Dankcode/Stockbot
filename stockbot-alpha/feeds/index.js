/**
 * Feed registry and the feature resolver.
 *
 * This is the bridge between "external data exists somewhere on the internet"
 * and "the algorithm's signal() can read a number at context.features.x[i]".
 *
 * The resolver runs ONCE per backtest, before the bar loop, and does three
 * things in strict order:
 *
 *   1. fetch    — via the provider, through the disk cache
 *   2. align    — bucket events onto bar indices, point-in-time correct
 *   3. reduce   — collapse each bucket into the numbers a strategy wants
 *
 * Step 2 is what makes step 3 safe. Nothing downstream of the aligner can see
 * an event it should not have, because the aligner never put it there.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { alignEvents, assertNoLookAhead, rollingWindow, barTimes } from "./align.js";
import { FeedCache, cacheKey } from "./cache.js";
import * as alpacaNews from "./providers/alpaca-news.js";
import * as secEdgar from "./providers/sec-edgar.js";
import * as rss from "./providers/rss.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.join(here, "..", "data", "feed-cache");

export const providers = new Map([
  [alpacaNews.id, alpacaNews],
  [secEdgar.id, secEdgar],
  [rss.id, rss]
]);

/** Report which providers are usable with the current environment. */
export function providerStatus(env = process.env) {
  return [...providers.values()].map((provider) => ({
    id: provider.id,
    label: provider.label,
    supportsHistory: provider.supportsHistory,
    ...provider.available(env)
  }));
}

/**
 * Fetch events for one provider/symbol/window, read-through cached.
 *
 * @returns {Promise<{events: object[], fromCache: boolean}>}
 */
export async function fetchFeed({
  provider: providerId,
  symbol,
  symbols,
  startMs,
  endMs,
  cacheDir = DEFAULT_CACHE_DIR,
  env = process.env,
  ...rest
}) {
  const provider = providers.get(providerId);
  if (!provider) {
    throw new Error(
      `Unknown feed provider "${providerId}". Available: ${[...providers.keys()].join(", ")}`
    );
  }
  const check = provider.available(env);
  if (!check.ok) throw new Error(`Feed "${providerId}" unavailable: ${check.reason}`);

  const targets = symbols ?? (symbol ? [symbol] : []);

  // A window whose right edge is in the future is still accumulating events, so
  // it gets a short TTL. A fully historical window is immutable — cache forever.
  const isOpenEnded = endMs > Date.now() - 60_000;
  const cache = new FeedCache(cacheDir, { ttlMs: isOpenEnded ? 5 * 60_000 : undefined });

  const key = cacheKey({ provider: providerId, symbol: targets.join(","), startMs, endMs, ...rest });
  const result = await cache.through(key, async () => {
    // Alpaca batches symbols in one request; EDGAR is per-CIK.
    if (providerId === alpacaNews.id) {
      return provider.fetchEvents({ symbols: targets, startMs, endMs, env, ...rest });
    }
    const all = [];
    for (const target of targets) {
      all.push(...(await provider.fetchEvents({ symbol: target, startMs, endMs, env, ...rest })));
    }
    all.sort((a, b) => a.publishedAt - b.publishedAt);
    return all;
  });

  return { events: result.data, fromCache: result.fromCache };
}

/**
 * Declared feature spec on an algorithm.
 *
 * @typedef {object} FeatureSpec
 * @property {string} provider           registry id
 * @property {number} [windowBars=1]     rolling lookback for the reducer
 * @property {number} [embargoMs=0]      extra latency before an event is visible
 * @property {string[]} [forms]          sec-edgar: form types to keep
 * @property {(events: object[], ctx: object) => any} [reduce]
 *           collapses a bucket into whatever signal() should read. Receives
 *           only events already proven visible at that bar.
 */

/**
 * Resolve every declared feature on an algorithm into bar-aligned arrays.
 *
 * @param {object} params
 * @param {object} params.algorithm      must expose `features` (see FeatureSpec)
 * @param {Array<{time: number|string}>} params.bars
 * @param {string} params.symbol
 * @param {"backtest"|"live"} [params.mode="backtest"]
 * @returns {Promise<{features: Record<string, any[]>, report: object[]}>}
 */
export async function resolveFeatures({
  algorithm,
  bars,
  symbol,
  mode = "backtest",
  cacheDir = DEFAULT_CACHE_DIR,
  env = process.env
}) {
  const specs = algorithm?.features ?? {};
  const names = Object.keys(specs);
  const features = {};
  const report = [];

  if (names.length === 0) return { features, report };

  const times = barTimes(bars);
  const startMs = times[0];
  // Right edge open by one bar interval so an event inside the final bar is
  // still fetched — the aligner will decide whether it is visible.
  const interval = times.length > 1 ? times[1] - times[0] : 60_000;
  const endMs = times[times.length - 1] + interval;

  for (const name of names) {
    const spec = specs[name];
    const provider = providers.get(spec.provider);
    if (!provider) {
      throw new Error(`Feature "${name}" references unknown provider "${spec.provider}".`);
    }

    // The guard that stops the most seductive mistake in this whole package.
    if (mode === "backtest" && !provider.supportsHistory) {
      throw new Error(
        `Feature "${name}" uses provider "${spec.provider}", which has no historical data. ` +
          `Backtesting against it would score today's events against past prices. ` +
          `Use it in live mode only, or switch to a provider with supportsHistory.`
      );
    }

    const { forms } = spec;
    const { events, fromCache } = await fetchFeed({
      provider: spec.provider,
      symbol,
      startMs,
      endMs,
      cacheDir,
      env,
      ...(forms ? { forms } : {})
    });

    const embargoMs = spec.embargoMs ?? 0;
    const { fresh, stats } = alignEvents(events, bars, { embargoMs });

    // Tripwire. Cheap relative to a backtest, and it turns a silent correctness
    // regression into a loud failure.
    assertNoLookAhead(fresh, bars, { embargoMs });

    const windowBars = spec.windowBars ?? 1;
    const windowed = windowBars > 1 ? rollingWindow(fresh, windowBars) : fresh;

    const reduce = spec.reduce ?? ((bucket) => bucket);
    features[name] = windowed.map((bucket, index) =>
      reduce(bucket, { index, bar: bars[index], symbol, spec })
    );

    report.push({
      feature: name,
      provider: spec.provider,
      symbol,
      windowBars,
      embargoMs,
      fromCache,
      events: stats
    });
  }

  return { features, report };
}

export { alignEvents, assertNoLookAhead, rollingWindow };
