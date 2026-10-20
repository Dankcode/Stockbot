import { describeReason } from "./orderReasons";
import type { ActivityItem } from "./types";

const TITLES: Record<string, string> = {
  session_created: "Session created",
  session_start: "Session starting",
  session_armed: "Session running",
  session_complete: "Backtest finished",
  session_signal: "Signal",
  signal: "Signal",
  session_order_filled: "Order filled",
  order_filled: "Order filled",
  session_order_rejected: "Order rejected",
  order_rejected: "Order rejected",
  session_protective_exit: "Protective exit",
  session_paused: "Session paused",
  session_resumed: "Session resumed",
  session_halted: "Session halted",
  session_stopped: "Session stopped",
  session_data_stale: "Market data stale — paused",
  session_bars_unavailable: "Bars unavailable",
  session_research_unavailable: "Research unavailable",
  session_restart_resumed: "Resumed after restart",
  session_restart_error: "Stopped by restart",
  session_next_open_unavailable: "Opening price unavailable",
  research_unavailable: "Research unavailable",
  state_transition: "State changed"
};

function humanize(code: string) {
  const text = code.replace(/^session_/, "").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function recordOf(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Normalizes audit rows, session events and alerts into one timeline shape
 * with readable titles. Raw audit rows carry `action` rather than a title, and
 * rendered as blank lines before this.
 */
export function activityFrom(raw: unknown, index = 0): ActivityItem {
  const event = recordOf(raw);
  const detail = recordOf(event.detailJson ?? event.detail);
  const code = String(event.action ?? event.actionTaken ?? event.type ?? "event");
  const transition = event.fromStatus && event.toStatus ? `${event.fromStatus} → ${event.toStatus}` : undefined;
  const symbol = typeof event.symbol === "string" ? event.symbol : typeof detail.symbol === "string" ? detail.symbol : undefined;
  const side = typeof detail.action === "string" ? detail.action.toUpperCase() : typeof detail.side === "string" ? detail.side.toUpperCase() : undefined;
  let title = typeof event.title === "string" ? event.title : TITLES[code] ?? humanize(code);
  if ((code.endsWith("signal") || code.endsWith("order_filled")) && symbol) title = `${title}: ${side ? `${side} ` : ""}${symbol}`;
  if (code === "state_transition" && transition) title = `State: ${transition}`;
  const reason = typeof detail.reason === "string" ? detail.reason : typeof event.rejectReason === "string" ? event.rejectReason : undefined;
  const described = code.includes("rejected") ? describeReason(reason) : null;
  const message = typeof event.message === "string" ? event.message : typeof detail.message === "string" ? detail.message : undefined;
  const severity = event.severity === "warn" || event.severity === "block" || event.severity === "halt"
    ? event.severity
    : code.includes("rejected") || code.includes("unavailable") || code.includes("stale") || code.includes("restart_error") ? "warn" : "info";
  return {
    id: String(event.id ?? `${code}:${event.at ?? index}`),
    at: typeof event.at === "number" ? event.at : Number(event.createdAt ?? 0),
    type: code,
    severity,
    title,
    detail: described ?? message ?? (typeof event.detail === "string" ? event.detail : undefined) ?? (code === "session_created" && Array.isArray(detail.symbols) ? `${detail.mode ?? ""} · ${detail.symbols.join(", ")}`.trim() : undefined),
    signalReason: typeof event.signalReason === "string" ? event.signalReason : typeof detail.signalReason === "string" ? detail.signalReason : undefined,
    symbol
  };
}
