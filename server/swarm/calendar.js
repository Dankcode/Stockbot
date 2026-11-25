/**
 * New York trading-day arithmetic for the swarm's daily jobs, staleness checks
 * and reviews. Trading days come from the same NYSE calendar the risk layer
 * uses (`marketSession`), so a holiday is skipped everywhere or nowhere.
 */
import { marketSession } from "../risk/market-hours.js";

export const NY = "America/New_York";
const DAY_MS = 86_400_000;

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});

function parts(at) {
  return Object.fromEntries(formatter.formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

/** "YYYY-MM-DD" of an instant in New York. */
export function nyDate(at) {
  const value = parts(at);
  return `${value.year}-${value.month}-${value.day}`;
}

/** Minutes after New York midnight of an instant. */
export function nyMinutes(at) {
  const value = parts(at);
  return Number(value.hour) * 60 + Number(value.minute);
}

/** UTC instant of a New York wall-clock time on a date (DST-correct). */
export function nyInstant(date, hour = 0, minute = 0) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let pass = 0; pass < 3; pass += 1) {
    const value = parts(guess);
    const asUtc = Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day), Number(value.hour), Number(value.minute));
    guess -= asUtc - target;
  }
  return guess;
}

/** True when NYSE has a regular session on this New York date. */
export function isTradingDate(date) {
  return marketSession("SPY", nyInstant(date, 12, 0)).reason === "regular_session";
}

function shift(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The trading date strictly before `date`. */
export function previousTradingDate(date) {
  let cursor = shift(date, -1);
  for (let guard = 0; guard < 15 && !isTradingDate(cursor); guard += 1) cursor = shift(cursor, -1);
  return cursor;
}

/** Trading dates from `from` to `to`, both inclusive, oldest first. */
export function tradingDatesBetween(from, to) {
  const dates = [];
  for (let cursor = from; cursor <= to; cursor = shift(cursor, 1)) if (isTradingDate(cursor)) dates.push(cursor);
  return dates;
}

/**
 * Oldest instant a Discovery run may have finished and still count as fresh:
 * New York midnight of the previous trading day. A Monday cycle accepts
 * Monday's run or, if it failed, Friday's; never last week's.
 */
export function discoveryFreshSince(at) {
  return nyInstant(previousTradingDate(nyDate(at)), 0, 0);
}

/** The trading date strictly after `date`. */
export function nextTradingDate(date) {
  let cursor = shift(date, 1);
  for (let guard = 0; guard < 15 && !isTradingDate(cursor); guard += 1) cursor = shift(cursor, 1);
  return cursor;
}
