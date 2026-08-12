import assert from "node:assert/strict";
import test from "node:test";
import {
  nextExchangeBarEvent,
  parseCron,
  scheduleAllows,
  validateSchedule
} from "../../server/runtime/schedules.js";
import {
  SessionScheduler,
  nextBoundary,
  nextSchedulerWake
} from "../../server/runtime/scheduler.js";

test("five-field UTC cron supports ranges, lists, and steps", () => {
  const matches = parseCron("*/15 9-10 * * 1-5");
  assert.equal(matches(new Date("2026-08-10T09:30:00Z")), true);
  assert.equal(matches(new Date("2026-08-10T11:30:00Z")), false);
  assert.throws(() => parseCron("bad cron"), /five fields/);
});

test("cron follows five-field day-of-month/weekday and Sunday conventions", () => {
  const firstOrMonday = parseCron("0 9 1 * 1");
  assert.equal(firstOrMonday(new Date("2026-09-01T09:00:00Z")), true, "the first of a month matches even when it is Tuesday");
  assert.equal(firstOrMonday(new Date("2026-09-07T09:00:00Z")), true, "a Monday matches even when it is not the first");
  assert.equal(firstOrMonday(new Date("2026-09-08T09:00:00Z")), false);
  assert.equal(parseCron("0 9 * * 7")(new Date("2026-09-06T09:00:00Z")), true);
});

test("fixed schedules never backfill a missed window", () => {
  const schedule = validateSchedule({ type: "fixed_window", startAt: 100, endAt: 200, timezone: "UTC" });
  assert.deepEqual(scheduleAllows(schedule, { now: 250 }), { allowed: false, reason: "after_window" });
});

test("intraday scheduling catches the current boundary settle window", () => {
  assert.equal(nextBoundary("1min", 60_001, 2_000), 62_000);
  assert.equal(nextBoundary("1min", 62_001, 2_000), 122_000);
});

test("NYSE daily, weekly, and monthly runs wake at exchange close then next open", () => {
  const mondayAfternoon = Date.parse("2026-08-10T18:00:00Z");
  const dailyClose = nextExchangeBarEvent("1day", mondayAfternoon, 2_000);
  assert.equal(new Date(dailyClose.at).toISOString(), "2026-08-10T20:00:02.000Z");
  assert.equal(dailyClose.trigger.phase, "close");

  const afterClose = nextExchangeBarEvent("1day", dailyClose.at + 1, 2_000);
  assert.equal(new Date(afterClose.at).toISOString(), "2026-08-11T13:30:02.000Z");
  assert.equal(afterClose.trigger.phase, "open");

  const weeklyClose = nextExchangeBarEvent("1week", mondayAfternoon, 2_000);
  assert.equal(new Date(weeklyClose.at).toISOString(), "2026-08-14T20:00:02.000Z");
  assert.equal(new Date(nextExchangeBarEvent("1week", weeklyClose.at + 1, 2_000).at).toISOString(), "2026-08-17T13:30:02.000Z");

  const monthlyClose = nextExchangeBarEvent("1month", mondayAfternoon, 2_000);
  assert.equal(new Date(monthlyClose.at).toISOString(), "2026-08-31T20:00:02.000Z");
  assert.equal(new Date(nextExchangeBarEvent("1month", monthlyClose.at + 1, 2_000).at).toISOString(), "2026-09-01T13:30:02.000Z");
});

test("NYSE exchange wakes follow DST and the last trading day of a holiday week", () => {
  const beforeDstWeekend = Date.parse("2026-03-06T18:00:00Z");
  const fridayClose = nextExchangeBarEvent("1day", beforeDstWeekend, 2_000);
  assert.equal(new Date(fridayClose.at).toISOString(), "2026-03-06T21:00:02.000Z");
  assert.equal(
    new Date(nextExchangeBarEvent("1day", fridayClose.at + 1, 2_000).at).toISOString(),
    "2026-03-09T13:30:02.000Z"
  );

  const goodFridayWeek = Date.parse("2026-03-30T18:00:00Z");
  assert.equal(
    new Date(nextExchangeBarEvent("1week", goodFridayWeek, 2_000).at).toISOString(),
    "2026-04-02T20:00:02.000Z"
  );
});

test("market-hours schedules allow the settled close event used for daily signals", () => {
  const close = Date.parse("2026-08-10T20:00:02Z");
  assert.deepEqual(
    scheduleAllows(
      { type: "market_hours", timezone: "America/New_York" },
      { now: close, symbol: "SPY", trigger: { kind: "market", phase: "close" } }
    ),
    { allowed: true, reason: "regular_session_close" }
  );

  const intradayClose = nextSchedulerWake({
    interval: "5min",
    now: Date.parse("2026-08-10T19:59:59Z"),
    settleDelayMs: 2_000,
    schedule: { type: "market_hours", timezone: "America/New_York" },
    symbols: ["SPY"]
  });
  assert.equal(new Date(intradayClose.at).toISOString(), "2026-08-10T20:00:02.000Z");
  assert.deepEqual(
    scheduleAllows(
      { type: "market_hours", timezone: "America/New_York" },
      { now: intradayClose.at, symbol: "SPY", trigger: intradayClose.trigger }
    ),
    { allowed: true, reason: "settled_regular_session_bar" }
  );
});

test("cron and fixed-window wakes are independent from bar boundaries", () => {
  const cronNow = Date.parse("2026-08-10T09:29:40Z");
  const cronWake = nextSchedulerWake({
    interval: "1hour",
    now: cronNow,
    schedule: { type: "cron", expression: "30 9 * * 1-5", timezone: "UTC" },
    symbols: ["SPY"]
  });
  assert.equal(new Date(cronWake.at).toISOString(), "2026-08-10T09:30:00.000Z");
  assert.equal(cronWake.trigger.kind, "cron");

  const coalescedClose = nextSchedulerWake({
    interval: "1day",
    now: Date.parse("2026-08-10T19:59:40Z"),
    settleDelayMs: 2_000,
    schedule: { type: "cron", expression: "0 16 * * 1-5", timezone: "America/New_York" },
    symbols: ["SPY"]
  });
  assert.equal(new Date(coalescedClose.at).toISOString(), "2026-08-10T20:00:02.000Z");
  assert.equal(coalescedClose.trigger.kind, "cron");
  assert.equal(coalescedClose.trigger.coalescedBarPhase, "close");

  const fixedWake = nextSchedulerWake({
    interval: "1min",
    now: 1_000,
    schedule: { type: "fixed_window", startAt: 1_500, endAt: 20_000, timezone: "UTC" },
    symbols: ["BTCUSD"]
  });
  assert.equal(fixedWake.at, 1_500);
  assert.equal(fixedWake.trigger.kind, "fixed_start");
  const fixedEnd = nextSchedulerWake({
    interval: "1min",
    now: 10_001,
    schedule: { type: "fixed_window", startAt: 1_500, endAt: 20_000, timezone: "UTC" },
    symbols: ["BTCUSD"],
    lastScheduleAt: 1_500
  });
  assert.equal(fixedEnd.at, 20_000);
  assert.equal(fixedEnd.trigger.kind, "fixed_end");
});

test("scheduled callback rejection is reported without escaping or stopping future ticks", async () => {
  const timers = [];
  const failures = [];
  const scheduler = new SessionScheduler({
    clock: () => Date.parse("2026-08-10T18:00:00Z"),
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
    onError(error, context) { failures.push({ error, context }); }
  });
  scheduler.schedule("paper-daily", "1day", async () => {
    throw new Error("strategy failed");
  }, { symbols: ["SPY"] });
  assert.equal(timers.length, 1);
  const first = timers.shift();
  await assert.doesNotReject(first.callback());
  assert.equal(failures.length, 1);
  assert.equal(failures[0].error.message, "strategy failed");
  assert.equal(timers.length, 1, "a contained failure should schedule the next tick");
  scheduler.cancelAll();
});

test("cron minute polling only invokes the session callback when the expression matches", async () => {
  const timers = [];
  let calls = 0;
  const scheduler = new SessionScheduler({
    clock: () => Date.parse("2026-08-10T09:29:40Z"),
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
    onError() {}
  });
  scheduler.schedule("cron-paper", "1hour", async () => { calls += 1; }, {
    schedule: { type: "cron", expression: "15 16 * * 1-5", timezone: "UTC" },
    symbols: ["SPY"]
  });
  await timers.shift().callback();
  assert.equal(calls, 0);
  assert.equal(timers.length, 1);
  scheduler.cancelAll();
});

test("a terminal callback result cancels instead of rearming", async () => {
  const timers = [];
  const scheduler = new SessionScheduler({
    clock: () => Date.parse("2026-08-10T18:00:00Z"),
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
    onError() {}
  });
  scheduler.schedule("finished", "1day", async () => ({ session: { status: "stopped" } }), { symbols: ["SPY"] });
  await timers.shift().callback();
  assert.equal(timers.length, 0);
});

test("monthly waits are chunked below Node's maximum timer delay", () => {
  const timers = [];
  let now = Date.parse("2026-09-01T13:30:03Z");
  let calls = 0;
  const scheduler = new SessionScheduler({
    clock: () => now,
    setTimer(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
    onError() {}
  });
  scheduler.schedule("paper-monthly", "1month", async () => { calls += 1; }, { symbols: ["SPY"] });
  const first = timers.shift();
  assert.equal(first.delay, 2_147_483_647);
  now += first.delay;
  first.callback();
  assert.equal(calls, 0, "a chunk timer must not run the scheduled session early");
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay > 0 && timers[0].delay < 2_147_483_647);
  scheduler.cancelAll();
});
