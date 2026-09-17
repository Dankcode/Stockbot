/**
 * Aligner tests — the leakage guard.
 *
 * These are the most important tests in the package. If the aligner is wrong,
 * every downstream number is wrong in the flattering direction, and nothing
 * else in the test suite would notice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  alignEvents,
  assertNoLookAhead,
  rollingWindow,
  barTimes,
  toEpochMs
} from "../feeds/align.js";
import { makeBars, makeEvents, HOUR } from "./fixtures.js";

const BASE = Date.UTC(2025, 0, 6, 14, 30);

test("toEpochMs accepts ISO strings, epoch seconds, epoch millis and Dates", () => {
  assert.equal(toEpochMs("2025-01-06T14:30:00.000Z"), BASE);
  assert.equal(toEpochMs(BASE), BASE);
  assert.equal(toEpochMs(Math.floor(BASE / 1000)), BASE);
  assert.equal(toEpochMs(new Date(BASE)), BASE);
  assert.equal(toEpochMs(String(BASE)), BASE);
});

test("toEpochMs throws rather than producing NaN", () => {
  // Silent NaN here is exactly how leakage sneaks in, so this must be loud.
  assert.throws(() => toEpochMs("not a date"), /unparseable/);
  assert.throws(() => toEpochMs(""), /empty string/);
  assert.throws(() => toEpochMs(Number.NaN), /non-finite/);
  assert.throws(() => toEpochMs(null), /expected number/);
  assert.throws(() => toEpochMs(new Date("garbage")), /invalid Date/);
});

test("barTimes rejects a non-monotonic series", () => {
  const bars = makeBars({ count: 5 });
  const shuffled = [bars[0], bars[2], bars[1], bars[3], bars[4]];
  assert.throws(() => barTimes(shuffled), /strictly increasing/);
});

test("an event published during bar i is first visible at bar i+1", () => {
  const bars = makeBars({ count: 6, startMs: BASE, intervalMs: HOUR });
  // Bar 2 opens at BASE + 2h. Publish 30 minutes into it.
  const events = makeEvents([{ offsetMs: 2 * HOUR + 30 * 60_000, headline: "mid-bar news" }], BASE);

  const { fresh } = alignEvents(events, bars);

  assert.equal(fresh[2].length, 0, "must not be visible in the bar it was published in");
  assert.equal(fresh[3].length, 1, "first visible at the next bar");
  assert.equal(fresh[3][0].headline, "mid-bar news");
});

test("an event published exactly at a bar open is visible at that bar", () => {
  const bars = makeBars({ count: 5, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents([{ offsetMs: 3 * HOUR, headline: "on the open" }], BASE);

  const { fresh } = alignEvents(events, bars);
  assert.equal(fresh[3].length, 1);
  assert.equal(fresh[2].length, 0);
});

test("events before the series land in bucket 0 and are counted", () => {
  const bars = makeBars({ count: 4, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents([{ offsetMs: -5 * HOUR, headline: "old" }], BASE);

  const { fresh, stats } = alignEvents(events, bars);
  assert.equal(fresh[0].length, 1);
  assert.equal(stats.beforeSeries, 1);
  assert.equal(stats.placed, 1);
  assert.equal(stats.dropped, 0);
});

test("events after the series are dropped, never carried backward", () => {
  const bars = makeBars({ count: 4, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents([{ offsetMs: 99 * HOUR, headline: "future" }], BASE);

  const { fresh, stats } = alignEvents(events, bars);
  assert.equal(stats.dropped, 1);
  assert.equal(stats.placed, 0);
  assert.equal(fresh.flat().length, 0, "a future event must not appear in any bucket");
});

test("embargo delays visibility by whole bars", () => {
  const bars = makeBars({ count: 8, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents([{ offsetMs: 2 * HOUR, headline: "embargoed" }], BASE);

  const none = alignEvents(events, bars, { embargoMs: 0 });
  assert.equal(none.fresh[2].length, 1);

  // 90 minutes of embargo pushes a 2h-mark event past the 3h bar into the 4h bar.
  const delayed = alignEvents(events, bars, { embargoMs: 90 * 60_000 });
  assert.equal(delayed.fresh[2].length, 0);
  assert.equal(delayed.fresh[3].length, 0);
  assert.equal(delayed.fresh[4].length, 1);
});

test("each event lands in exactly one bucket", () => {
  const bars = makeBars({ count: 40, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents(
    Array.from({ length: 25 }, (_, i) => ({ offsetMs: i * 1.4 * HOUR, headline: `n${i}` })),
    BASE
  );

  const { fresh, stats } = alignEvents(events, bars);
  const placed = fresh.flat();
  assert.equal(placed.length, stats.placed);

  const ids = placed.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "no event may be duplicated across buckets");
});

test("unsorted input is handled correctly", () => {
  const bars = makeBars({ count: 10, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents(
    [
      { offsetMs: 7 * HOUR, headline: "late" },
      { offsetMs: 1 * HOUR, headline: "early" },
      { offsetMs: 4 * HOUR, headline: "middle" }
    ],
    BASE
  );

  const { fresh } = alignEvents(events, bars);
  assert.equal(fresh[1][0].headline, "early");
  assert.equal(fresh[4][0].headline, "middle");
  assert.equal(fresh[7][0].headline, "late");
});

test("records with unusable timestamps are counted, not admitted", () => {
  const bars = makeBars({ count: 5, startMs: BASE, intervalMs: HOUR });
  const events = [
    { id: "good", publishedAt: BASE + 2 * HOUR, headline: "ok" },
    { id: "bad", publishedAt: "definitely not a date", headline: "broken" },
    { id: "worse", publishedAt: null, headline: "also broken" }
  ];

  const { fresh, stats } = alignEvents(events, bars);
  assert.equal(stats.invalid, 2);
  assert.equal(stats.placed, 1);
  assert.equal(fresh.flat().length, 1);
});

test("assertNoLookAhead passes on aligner output and catches manual leaks", () => {
  const bars = makeBars({ count: 12, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents(
    Array.from({ length: 8 }, (_, i) => ({ offsetMs: i * 1.3 * HOUR, headline: `n${i}` })),
    BASE
  );

  const { fresh } = alignEvents(events, bars);
  assert.doesNotThrow(() => assertNoLookAhead(fresh, bars));

  // Inject a future event into an early bucket — precisely the bug class.
  const leaked = fresh.map((b) => [...b]);
  leaked[1].push({ publishedAt: BASE + 10 * HOUR, headline: "leaked from the future" });
  assert.throws(() => assertNoLookAhead(leaked, bars), /LOOK-AHEAD LEAK at bar 1/);
});

test("assertNoLookAhead accounts for embargo", () => {
  const bars = makeBars({ count: 6, startMs: BASE, intervalMs: HOUR });
  const buckets = Array.from({ length: 6 }, () => []);
  // Visible at 2h with no embargo, but not until 3h with an hour of embargo.
  buckets[2].push({ publishedAt: BASE + 2 * HOUR, headline: "borderline" });

  assert.doesNotThrow(() => assertNoLookAhead(buckets, bars, { embargoMs: 0 }));
  assert.throws(() => assertNoLookAhead(buckets, bars, { embargoMs: HOUR }), /LOOK-AHEAD LEAK/);
});

test("rollingWindow accumulates backward only", () => {
  const buckets = [["a"], ["b"], [], ["c"], ["d"]];
  const windowed = rollingWindow(buckets, 3);

  assert.deepEqual(windowed[0], ["a"]);
  assert.deepEqual(windowed[1], ["a", "b"]);
  assert.deepEqual(windowed[2], ["a", "b"]);
  assert.deepEqual(windowed[3], ["b", "c"]);
  assert.deepEqual(windowed[4], ["c", "d"]);
});

test("a rolling window never reaches forward", () => {
  const bars = makeBars({ count: 20, startMs: BASE, intervalMs: HOUR });
  const events = makeEvents(
    Array.from({ length: 15 }, (_, i) => ({ offsetMs: i * 1.2 * HOUR, headline: `n${i}` })),
    BASE
  );

  const { fresh } = alignEvents(events, bars);
  const windowed = rollingWindow(fresh, 5);
  // The window is a superset of a single bucket, so the leakage guard must
  // still hold across it.
  assert.doesNotThrow(() => assertNoLookAhead(windowed, bars));
});

test("embargoMs must be non-negative", () => {
  const bars = makeBars({ count: 4 });
  assert.throws(() => alignEvents([], bars, { embargoMs: -1 }), /non-negative/);
});

test("empty event list yields empty buckets of the right length", () => {
  const bars = makeBars({ count: 7 });
  const { fresh, stats } = alignEvents([], bars);
  assert.equal(fresh.length, 7);
  assert.equal(fresh.flat().length, 0);
  assert.equal(stats.total, 0);
});
