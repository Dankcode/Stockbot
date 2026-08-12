import { AppError } from "../http/errors.js";
import { marketSession } from "../risk/market-hours.js";

const DAY_MS = 86_400_000;
export const SCHEDULE_MINUTE_MS = 60_000;
export const EXCHANGE_TIMEZONE = "America/New_York";

const dateTimeFormatters = new Map();

function dateTimeFormatter(timeZone) {
  if (!dateTimeFormatters.has(timeZone)) {
    dateTimeFormatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }));
  }
  return dateTimeFormatters.get(timeZone);
}

export function zonedDateTimeParts(at, timeZone = "UTC") {
  const numeric = Number(at);
  if (!Number.isFinite(numeric)) throw new TypeError("Schedule time must be finite.");
  try {
    return Object.fromEntries(
      dateTimeFormatter(timeZone)
        .formatToParts(numeric)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)])
    );
  } catch {
    throw new AppError("INVALID_SCHEDULE", `Unknown schedule timezone: ${timeZone}`, 400);
  }
}

function utcProjection(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
}

/** Convert an exchange-local wall-clock value to epoch milliseconds, including DST. */
export function epochForZonedDateTime(parts, timeZone = "UTC") {
  const target = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour ?? 0),
    minute: Number(parts.minute ?? 0),
    second: Number(parts.second ?? 0)
  };
  if (!Object.values(target).every(Number.isInteger)) throw new TypeError("Zoned date-time parts must be integers.");
  let candidate = utcProjection(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = zonedDateTimeParts(candidate, timeZone);
    const delta = utcProjection(target) - utcProjection(rendered);
    candidate += delta;
    if (delta === 0) return candidate;
  }
  return candidate;
}

function addCalendarDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function exchangeSessionForDate(parts) {
  const openAt = epochForZonedDateTime({ ...parts, hour: 9, minute: 30 }, EXCHANGE_TIMEZONE);
  if (!marketSession("SPY", openAt + SCHEDULE_MINUTE_MS).open) return null;
  return Object.freeze({
    ...parts,
    openAt,
    closeAt: epochForZonedDateTime({ ...parts, hour: 16, minute: 0 }, EXCHANGE_TIMEZONE)
  });
}

function weekKey(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
}

function closesPeriod(interval, session, nextSession) {
  if (interval === "1day") return true;
  if (!nextSession) return false;
  if (interval === "1week") return weekKey(session) !== weekKey(nextSession);
  if (interval === "1month") return session.year !== nextSession.year || session.month !== nextSession.month;
  return false;
}

/**
 * Returns the next NYSE open/close event needed by a higher-timeframe paper
 * strategy. Weekly and monthly closes follow the last actual trading session,
 * so Friday/month-end holidays do not silently skip a run.
 */
export function nextExchangeBarEvent(interval, after = Date.now(), settleDelayMs = 2_000) {
  if (!["1day", "1week", "1month"].includes(interval)) {
    throw new TypeError(`Exchange events do not support interval: ${interval}.`);
  }
  const now = Number(after);
  const local = zonedDateTimeParts(now, EXCHANGE_TIMEZONE);
  const sessions = [];
  for (let offset = -10; offset <= 70; offset += 1) {
    const session = exchangeSessionForDate(addCalendarDays(local, offset));
    if (session) sessions.push(session);
  }
  const candidates = [];
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const previous = sessions[index - 1];
    const next = sessions[index + 1];
    if (previous && closesPeriod(interval, previous, session)) {
      candidates.push({
        at: session.openAt + settleDelayMs,
        trigger: { kind: "market", phase: "open", interval, scheduledAt: session.openAt + settleDelayMs }
      });
    }
    if (closesPeriod(interval, session, next)) {
      candidates.push({
        at: session.closeAt + settleDelayMs,
        trigger: { kind: "market", phase: "close", interval, scheduledAt: session.closeAt + settleDelayMs }
      });
    }
  }
  const next = candidates
    .filter((candidate) => candidate.at > now)
    .sort((left, right) => left.at - right.at)[0];
  if (!next) throw new Error(`Could not resolve the next ${interval} NYSE boundary.`);
  return Object.freeze({ at: next.at, trigger: Object.freeze(next.trigger) });
}

function parseField(value, minimum, maximum) {
  if (value === "*") return () => true;
  const allowed = new Set();
  for (const part of value.split(",")) {
    const stepParts = part.split("/");
    const step = stepParts[1] ? Number(stepParts[1]) : 1;
    const range = stepParts[0] === "*" ? [minimum, maximum] : stepParts[0].includes("-") ? stepParts[0].split("-").map(Number) : [Number(stepParts[0]), Number(stepParts[0])];
    if (!Number.isInteger(step) || step <= 0 || range.some((item) => !Number.isInteger(item)) || range[0] < minimum || range[1] > maximum || range[0] > range[1]) throw new AppError("INVALID_SCHEDULE", `Invalid cron field: ${value}`, 400);
    for (let cursor = range[0]; cursor <= range[1]; cursor += step) allowed.add(cursor);
  }
  return (candidate) => allowed.has(candidate);
}

export function parseCron(expression, { timeZone = "UTC" } = {}) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new AppError("INVALID_SCHEDULE", "Cron must have five fields: minute hour day month weekday.", 400);
  const [minute, hour, day, month, weekdayField] = [
    parseField(fields[0], 0, 59), parseField(fields[1], 0, 23), parseField(fields[2], 1, 31), parseField(fields[3], 1, 12), parseField(fields[4], 0, 7)
  ];
  const weekday = (candidate) => weekdayField(candidate) || (candidate === 0 && weekdayField(7));
  const dayRestricted = fields[2] !== "*";
  const weekdayRestricted = fields[4] !== "*";
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, minute: "2-digit", hour: "2-digit", hourCycle: "h23", day: "2-digit", month: "2-digit", weekday: "short" });
  } catch { throw new AppError("INVALID_SCHEDULE", `Unknown schedule timezone: ${timeZone}`, 400); }
  const week = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (date) => {
    const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const dayMatches = day(Number(parts.day));
    const weekdayMatches = weekday(week[parts.weekday]);
    const calendarDayMatches = dayRestricted && weekdayRestricted
      ? dayMatches || weekdayMatches
      : dayMatches && weekdayMatches;
    return minute(Number(parts.minute)) && hour(Number(parts.hour)) && month(Number(parts.month)) && calendarDayMatches;
  };
}

export function validateSchedule(schedule = {}) {
  const type = schedule.type || "manual";
  if (!["manual", "market_hours", "fixed_window", "cron", "continuous"].includes(type)) throw new AppError("INVALID_SCHEDULE", `Unknown schedule type: ${type}`, 400);
  if (type === "fixed_window" && (!Number.isSafeInteger(schedule.startAt) || !Number.isSafeInteger(schedule.endAt) || schedule.endAt <= schedule.startAt)) throw new AppError("INVALID_SCHEDULE", "Fixed window requires startAt before endAt.", 400);
  if (type === "cron") parseCron(schedule.expression, { timeZone: schedule.timezone || "UTC" });
  return { timezone: schedule.timezone || (type === "market_hours" ? "America/New_York" : "UTC"), ...schedule, type };
}

export function scheduleAllows(scheduleInput, { now = Date.now(), symbol, trigger } = {}) {
  const schedule = validateSchedule(scheduleInput);
  if (schedule.type === "manual" || schedule.type === "continuous") return { allowed: true, reason: schedule.type };
  if (schedule.type === "market_hours") {
    if (trigger?.kind === "market" && trigger.phase === "close") {
      return { allowed: true, reason: "regular_session_close" };
    }
    const session = marketSession(symbol, now);
    if (!session.open && trigger?.kind === "bar" && trigger.phase === "boundary" &&
        Number.isSafeInteger(trigger.boundaryAt) && marketSession(symbol, trigger.boundaryAt - 1).open) {
      return { allowed: true, reason: "settled_regular_session_bar" };
    }
    return { allowed: session.open, reason: session.reason };
  }
  if (schedule.type === "fixed_window") return { allowed: now >= schedule.startAt && now < schedule.endAt, reason: now < schedule.startAt ? "before_window" : now >= schedule.endAt ? "after_window" : "inside_window" };
  const matches = parseCron(schedule.expression, { timeZone: schedule.timezone })(new Date(now));
  return { allowed: matches, reason: matches ? "cron_match" : "cron_wait" };
}
