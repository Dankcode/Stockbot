import { isCryptoSymbol } from "../market/catalog.js";
import {
  SCHEDULE_MINUTE_MS,
  nextExchangeBarEvent,
  parseCron,
  validateSchedule
} from "./schedules.js";

const INTERVAL_MS = Object.freeze({
  "1min": 60_000,
  "5min": 300_000,
  "15min": 900_000,
  "30min": 1_800_000,
  "1hour": 3_600_000,
  "1day": 86_400_000,
  "1week": 7 * 86_400_000
});
const HIGHER_INTERVALS = new Set(["1day", "1week", "1month"]);
const TERMINAL_STATUSES = new Set(["stopped", "halted", "errored"]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Next fixed-duration boundary plus provider settle delay. Starting a scheduler
 * after a boundary but before its settle delay still catches that boundary.
 */
export function nextBoundary(interval, now = Date.now(), settleDelayMs = 2_000) {
  const duration = INTERVAL_MS[interval];
  if (!duration) throw new Error(`Unsupported scheduler interval: ${interval}`);
  const currentBoundary = Math.floor(now / duration) * duration;
  const currentSettled = currentBoundary + settleDelayMs;
  return currentSettled > now ? currentSettled : currentBoundary + duration + settleDelayMs;
}

function cryptoOnly(symbols) {
  return Array.isArray(symbols) && symbols.length > 0 && symbols.every(isCryptoSymbol);
}

function nextUtcCalendarBoundary(interval, now, settleDelayMs) {
  const date = new Date(now);
  let boundary;
  if (interval === "1day") {
    boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    if (boundary + settleDelayMs <= now) boundary += 86_400_000;
  } else if (interval === "1week") {
    const daysFromMonday = (date.getUTCDay() + 6) % 7;
    boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysFromMonday);
    if (boundary + settleDelayMs <= now) boundary += 7 * 86_400_000;
  } else {
    boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    if (boundary + settleDelayMs <= now) {
      boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
  const at = boundary + settleDelayMs;
  return {
    at,
    trigger: { kind: "bar", phase: "boundary", interval, scheduledAt: at }
  };
}

function naturalWake(interval, now, settleDelayMs, symbols) {
  if (HIGHER_INTERVALS.has(interval)) {
    return cryptoOnly(symbols)
      ? nextUtcCalendarBoundary(interval, now, settleDelayMs)
      : nextExchangeBarEvent(interval, now, settleDelayMs);
  }
  const at = nextBoundary(interval, now, settleDelayMs);
  return {
    at,
    trigger: {
      kind: "bar",
      phase: "boundary",
      interval,
      boundaryAt: at - settleDelayMs,
      scheduledAt: at
    }
  };
}

function scheduleWake(schedule, now, lastScheduleAt) {
  if (schedule.type === "cron") {
    const currentMinute = Math.floor(now / SCHEDULE_MINUTE_MS) * SCHEDULE_MINUTE_MS;
    const matchesCurrent = parseCron(schedule.expression, { timeZone: schedule.timezone })(new Date(now));
    if (matchesCurrent && currentMinute !== lastScheduleAt) {
      return {
        at: now,
        trigger: { kind: "cron", phase: "schedule", scheduledAt: currentMinute }
      };
    }
    const at = currentMinute + SCHEDULE_MINUTE_MS;
    const matchesNext = parseCron(schedule.expression, { timeZone: schedule.timezone })(new Date(at));
    return {
      at,
      trigger: { kind: matchesNext ? "cron" : "cron_poll", phase: "schedule", scheduledAt: at }
    };
  }
  if (schedule.type !== "fixed_window") return null;
  if (now < schedule.startAt && schedule.startAt !== lastScheduleAt) {
    return {
      at: schedule.startAt,
      trigger: { kind: "fixed_start", phase: "schedule", scheduledAt: schedule.startAt }
    };
  }
  if (now < schedule.endAt && schedule.endAt !== lastScheduleAt) {
    return {
      at: schedule.endAt,
      trigger: { kind: "fixed_end", phase: "schedule", scheduledAt: schedule.endAt }
    };
  }
  return null;
}

function priority(candidate) {
  return {
    fixed_end: 0,
    fixed_start: 1,
    market: 2,
    cron: 3,
    cron_poll: 4,
    bar: 5
  }[candidate.trigger.kind] ?? 10;
}

/** Resolve the next market/bar or schedule wake without tying cron/window time to a bar boundary. */
export function nextSchedulerWake({
  interval,
  now = Date.now(),
  settleDelayMs = 2_000,
  schedule: scheduleInput = { type: "manual", timezone: "UTC" },
  symbols = [],
  lastScheduleAt = null
}) {
  const schedule = validateSchedule(scheduleInput);
  const natural = naturalWake(interval, now, settleDelayMs, symbols);
  const candidates = [natural];
  const configured = scheduleWake(schedule, now, lastScheduleAt);
  if (configured?.trigger.kind === "cron" &&
      natural.at - settleDelayMs === configured.trigger.scheduledAt) {
    return {
      at: natural.at,
      trigger: {
        ...configured.trigger,
        interval,
        coalescedBarPhase: natural.trigger.phase
      }
    };
  }
  if (configured) candidates.push(configured);
  return candidates.sort((left, right) => left.at - right.at || priority(left) - priority(right))[0];
}

function terminalResult(result) {
  const status = result?.session?.status ?? result?.status;
  return result?.terminal === true || TERMINAL_STATUSES.has(status);
}

function defaultErrorReporter(error, context) {
  console.error(`Scheduled session ${context.id} tick failed:`, error);
}

export class SessionScheduler {
  #tasks = new Map();
  #settleDelayMs;
  #clock;
  #setTimer;
  #clearTimer;
  #onError;

  constructor({
    settleDelayMs = 2_000,
    clock = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onError = defaultErrorReporter
  } = {}) {
    this.#settleDelayMs = settleDelayMs;
    this.#clock = clock;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onError = onError;
  }

  async #report(error, task, trigger) {
    try {
      await this.#onError(error, { id: task.id, interval: task.interval, trigger });
    } catch (reportError) {
      try {
        defaultErrorReporter(reportError, { id: task.id });
      } catch {
        // Error reporting must never turn a contained tick failure into a process crash.
      }
    }
  }

  #arm(task) {
    if (this.#tasks.get(task.id) !== task) return;
    const now = this.#clock();
    const wake = nextSchedulerWake({
      interval: task.interval,
      now,
      settleDelayMs: this.#settleDelayMs,
      schedule: task.schedule,
      symbols: task.symbols,
      lastScheduleAt: task.lastScheduleAt
    });
    const delay = Math.max(0, wake.at - now);
    if (delay > MAX_TIMER_DELAY_MS) {
      const timer = this.#setTimer(() => {
        if (this.#tasks.get(task.id) !== task) return;
        task.timer = null;
        this.#arm(task);
      }, MAX_TIMER_DELAY_MS);
      timer?.unref?.();
      task.timer = timer;
      return;
    }
    const timer = this.#setTimer(async () => {
      if (this.#tasks.get(task.id) !== task) return;
      task.timer = null;
      if (["cron", "fixed_start", "fixed_end"].includes(wake.trigger.kind)) {
        task.lastScheduleAt = wake.trigger.scheduledAt;
      }
      try {
        if (wake.trigger.kind !== "cron_poll") {
          const result = await task.callback(wake.trigger);
          if (terminalResult(result) && this.#tasks.get(task.id) === task) this.cancel(task.id);
        }
      } catch (error) {
        await this.#report(error, task, wake.trigger);
      } finally {
        if (this.#tasks.get(task.id) === task) this.#arm(task);
      }
    }, delay);
    timer?.unref?.();
    task.timer = timer;
  }

  schedule(id, interval, callback, options = {}) {
    if (typeof callback !== "function") throw new TypeError("Scheduled session callback must be a function.");
    this.cancel(id);
    const task = {
      id,
      interval,
      callback,
      schedule: validateSchedule(options.schedule ?? { type: "manual", timezone: "UTC" }),
      symbols: Array.isArray(options.symbols) ? [...options.symbols] : [],
      lastScheduleAt: null,
      timer: null
    };
    this.#tasks.set(id, task);
    this.#arm(task);
  }

  cancel(id) {
    const task = this.#tasks.get(id);
    if (task?.timer) this.#clearTimer(task.timer);
    this.#tasks.delete(id);
  }

  cancelAll() {
    for (const id of this.#tasks.keys()) this.cancel(id);
  }
}
