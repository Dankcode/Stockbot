import { isCryptoSymbol } from "../market/catalog.js";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});

// Full-day NYSE holidays. Early closes are intentionally treated as closed only
// after a provider/exchange calendar is introduced; the quote-freshness rule is
// still authoritative for all order fills.
const HOLIDAYS = new Set([
  "01/01/2026", "01/19/2026", "02/16/2026", "04/03/2026", "05/25/2026", "06/19/2026", "07/03/2026", "09/07/2026", "11/26/2026", "12/25/2026",
  "01/01/2027", "01/18/2027", "02/15/2027", "03/26/2027", "05/31/2027", "06/18/2027", "07/05/2027", "09/06/2027", "11/25/2027", "12/24/2027"
]);

export function marketSession(symbol, at = Date.now()) {
  if (isCryptoSymbol(symbol)) return { open: true, venue: "crypto", timezone: "UTC", reason: "continuous" };
  const parts = Object.fromEntries(formatter.formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const date = `${parts.month}/${parts.day}/${parts.year}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = parts.weekday;
  const weekdayOpen = !["Sat", "Sun"].includes(weekday);
  const holiday = HOLIDAYS.has(date);
  const open = weekdayOpen && !holiday && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  return {
    open,
    venue: "NYSE",
    timezone: "America/New_York",
    reason: !weekdayOpen ? "weekend" : holiday ? "holiday" : open ? "regular_session" : "outside_regular_session"
  };
}
