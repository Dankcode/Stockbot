/**
 * Point-in-time alignment of timestamped events onto bar indices.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * The single most common way a news-driven backtest lies to you is by letting
 * the algorithm see an article before it was published. It happens quietly:
 * you fetch 30 days of news, hand the whole array to the strategy, and the
 * strategy indexes into it by symbol instead of by time. Returns look
 * fantastic. None of it is real.
 *
 * This module is the only place that maps events → bar indices, and it does so
 * under one rule:
 *
 *     An event is visible at bar i only if
 *         event.publishedAt + embargoMs <= bars[i].time
 *
 * `bars[i].time` is treated as the bar's OPEN timestamp, which is the
 * convention Alpaca, Polygon and Finnhub all use. Combined with the
 * next-bar-open fill model in ../training/fill-model.js, an event published
 * during bar i is first *visible* at bar i+1 and first *tradable* at the open
 * of bar i+2. That is deliberately conservative: it is better to understate an
 * edge than to manufacture one.
 *
 * `embargoMs` adds further latency on top. Set it to model the real gap
 * between a wire crossing and you being able to act — a few seconds for an
 * automated reader, minutes if a human is in the loop. Zero is permitted but
 * optimistic.
 */

/**
 * Coerce a timestamp into epoch milliseconds.
 *
 * Deliberately strict. A silent NaN here would compare false against every
 * threshold and quietly drop or admit events at random, which is precisely the
 * failure this module exists to prevent — so unparseable input throws.
 *
 * @param {number|string|Date} value
 * @param {string} label used in the error message
 * @returns {number} epoch milliseconds
 */
export function toEpochMs(value, label = "timestamp") {
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError(`${label}: invalid Date`);
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label}: non-finite number`);
    // Heuristic: treat 10-digit values as seconds, 13-digit as milliseconds.
    // Anything before 1973 in ms terms is almost certainly seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") throw new TypeError(`${label}: empty string`);
    if (/^\d+$/.test(trimmed)) return toEpochMs(Number(trimmed), label);
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) throw new TypeError(`${label}: unparseable "${value}"`);
    return ms;
  }
  throw new TypeError(`${label}: expected number, string or Date, got ${typeof value}`);
}

/**
 * Normalize a bar series into a monotonically increasing epoch-ms array.
 *
 * @param {Array<{time: number|string}>} bars
 * @returns {number[]}
 */
export function barTimes(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error("barTimes: bars must be a non-empty array");
  }
  const times = bars.map((bar, i) => toEpochMs(bar.time ?? bar.t, `bars[${i}].time`));
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] <= times[i - 1]) {
      throw new Error(
        `barTimes: bars must be strictly increasing in time; ` +
          `bars[${i}] (${new Date(times[i]).toISOString()}) is not after ` +
          `bars[${i - 1}] (${new Date(times[i - 1]).toISOString()})`
      );
    }
  }
  return times;
}

/**
 * Normalize an arbitrary feed record into the canonical event shape.
 *
 * @param {object} raw
 * @param {(raw: object) => number|string} pickTime
 * @returns {{publishedAt: number, raw: object}}
 */
function normalizeEvent(raw, pickTime) {
  return { publishedAt: toEpochMs(pickTime(raw), "event.publishedAt"), raw };
}

/**
 * Bucket timestamped events onto bar indices, point-in-time correct.
 *
 * Each event lands in exactly one bucket: the index of the first bar at which
 * it became visible. An event visible before the series starts lands in bucket
 * 0. An event that never becomes visible within the series is dropped and
 * counted in `stats.dropped`.
 *
 * @param {object[]} events
 * @param {Array<{time: number|string}>} bars
 * @param {object} [options]
 * @param {number} [options.embargoMs=0] extra latency before an event is visible
 * @param {(e: object) => number|string} [options.timeKey] extracts the publish time
 * @returns {{
 *   fresh: object[][],
 *   stats: {total: number, placed: number, dropped: number, beforeSeries: number, invalid: number}
 * }}
 */
export function alignEvents(events, bars, options = {}) {
  const { embargoMs = 0, timeKey = (e) => e.publishedAt ?? e.published_at ?? e.created_at ?? e.time } =
    options;

  if (!Number.isFinite(embargoMs) || embargoMs < 0) {
    throw new RangeError("alignEvents: embargoMs must be a non-negative finite number");
  }

  const times = barTimes(bars);
  const fresh = Array.from({ length: times.length }, () => []);
  const stats = { total: 0, placed: 0, dropped: 0, beforeSeries: 0, invalid: 0 };

  const normalized = [];
  for (const raw of events ?? []) {
    stats.total += 1;
    try {
      normalized.push(normalizeEvent(raw, timeKey));
    } catch {
      // A record with an unusable timestamp cannot be placed safely. Count it
      // and move on — surfacing the count matters more than the record.
      stats.invalid += 1;
    }
  }

  normalized.sort((a, b) => a.publishedAt - b.publishedAt);

  // Single merge pass. `cursor` only ever moves forward, so this is O(n + m).
  let cursor = 0;
  for (const event of normalized) {
    const visibleAt = event.publishedAt + embargoMs;

    if (visibleAt <= times[0]) {
      fresh[0].push(event.raw);
      stats.placed += 1;
      stats.beforeSeries += 1;
      continue;
    }

    while (cursor < times.length && times[cursor] < visibleAt) cursor += 1;

    if (cursor >= times.length) {
      // Published (or embargoed) past the end of the series — never actionable.
      stats.dropped += 1;
      continue;
    }

    fresh[cursor].push(event.raw);
    stats.placed += 1;
  }

  return { fresh, stats };
}

/**
 * Build a rolling window view over aligned buckets.
 *
 * `out[i]` contains every event visible in the `windowBars` bars ending at i
 * (inclusive). Used by features that care about recent news density rather
 * than a single bar's worth — "how much did the wire say about this name in
 * the last day" is usually a better signal than "was there an article at
 * exactly 10:30".
 *
 * @param {object[][]} buckets output of alignEvents().fresh
 * @param {number} windowBars
 * @returns {object[][]}
 */
export function rollingWindow(buckets, windowBars) {
  if (!Number.isInteger(windowBars) || windowBars < 1) {
    throw new RangeError("rollingWindow: windowBars must be a positive integer");
  }
  return buckets.map((_, i) => {
    const start = Math.max(0, i - windowBars + 1);
    const out = [];
    for (let j = start; j <= i; j += 1) out.push(...buckets[j]);
    return out;
  });
}

/**
 * Assert that no bucket contains an event published after its bar.
 *
 * This is the leakage tripwire. It is cheap, so the walk-forward harness runs
 * it on every fold rather than trusting that alignEvents stayed correct
 * through future edits. If this throws, a backtest result is invalid — not
 * merely suspect.
 *
 * @param {object[][]} buckets
 * @param {Array<{time: number|string}>} bars
 * @param {object} [options]
 * @param {number} [options.embargoMs=0]
 * @param {(e: object) => number|string} [options.timeKey]
 */
export function assertNoLookAhead(buckets, bars, options = {}) {
  const { embargoMs = 0, timeKey = (e) => e.publishedAt ?? e.published_at ?? e.created_at ?? e.time } =
    options;
  const times = barTimes(bars);

  if (buckets.length !== times.length) {
    throw new Error(
      `assertNoLookAhead: bucket count ${buckets.length} does not match bar count ${times.length}`
    );
  }

  for (let i = 0; i < buckets.length; i += 1) {
    for (const event of buckets[i]) {
      const visibleAt = toEpochMs(timeKey(event), "event.publishedAt") + embargoMs;
      if (visibleAt > times[i]) {
        throw new Error(
          `LOOK-AHEAD LEAK at bar ${i}: event visible at ` +
            `${new Date(visibleAt).toISOString()} placed in a bar opening at ` +
            `${new Date(times[i]).toISOString()}. This backtest is invalid.`
        );
      }
    }
  }
}
