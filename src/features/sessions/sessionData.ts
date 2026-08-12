import type { ChartEquitySeries, ChartRiskEvent, ChartTrade } from "../../charts";
import type { Fill, Order } from "../../../packages/shared/schemas.js";
import { api, listFrom } from "../../lib/api";
import type { ActivityItem, EquityPoint, NormalizedEquityPoint, SessionCompare, SessionComparisonEntry, SessionDetail, SessionSummary } from "../../lib/types";

export type SessionOrder = Order & {
  fills: Fill[];
  filledAvgPrice?: number | null;
  filledAt?: number | null;
  signalBarAt?: number | null;
};

function objectAt<T>(payload: unknown, key: string): T {
  if (payload && typeof payload === "object" && key in payload) return (payload as Record<string, T>)[key];
  return payload as T;
}

export async function fetchSessions(path: string) {
  return listFrom<SessionSummary>(await api.get<unknown>(path), ["sessions", "items"]);
}

export async function fetchSession(id: string) {
  const payload = await api.get<unknown>(`/sessions/${encodeURIComponent(id)}`);
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const session = objectAt<SessionDetail>(payload, "session");
  return { ...session, metrics: root.metrics as SessionDetail["metrics"] ?? session.metrics };
}

export async function fetchSessionOrders(id: string) {
  const orders = listFrom<Order & { fills?: Fill[]; signalBarAt?: number | null }>(await api.get<unknown>(`/sessions/${encodeURIComponent(id)}/orders?limit=100`), ["orders", "items"]);
  return orders.map((order): SessionOrder => {
    const fills = Array.isArray(order.fills) ? order.fills : [];
    const firstFill = fills[0];
    return { ...order, fills, filledAvgPrice: firstFill?.price ?? null, filledAt: firstFill?.filledAt ?? null };
  });
}

export async function fetchSessionEvents(id: string) {
  const events = listFrom<Record<string, unknown>>(await api.get<unknown>(`/sessions/${encodeURIComponent(id)}/events`), ["events", "items"]);
  return events.map((event, index): ActivityItem => {
    const detail = event.detailJson && typeof event.detailJson === "object" ? event.detailJson as Record<string, unknown> : {};
    const transition = event.fromStatus && event.toStatus ? `${event.fromStatus} → ${event.toStatus}` : undefined;
    const title = event.title ?? event.action ?? event.actionTaken ?? transition ?? event.type;
    const description = event.detail ?? detail.message ?? detail.note ?? detail.reason;
    return {
      id: String(event.id ?? `${event.type ?? "event"}:${event.at ?? index}`),
      at: typeof event.at === "number" ? event.at : 0,
      type: String(event.type ?? "event"),
      severity: event.severity === "warn" || event.severity === "block" || event.severity === "halt" ? event.severity : "info",
      title: title == null ? undefined : String(title),
      detail: description == null ? (Object.keys(detail).length ? JSON.stringify(detail) : undefined) : String(description),
      signalReason: typeof event.signalReason === "string" ? event.signalReason : typeof detail.signalReason === "string" ? detail.signalReason : undefined,
      symbol: typeof event.symbol === "string" ? event.symbol : typeof detail.symbol === "string" ? detail.symbol : undefined
    };
  });
}

function pointFrom(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  const time = point.time ?? point.at;
  const equity = Number(point.equity);
  if ((typeof time !== "number" && typeof time !== "string") || !Number.isFinite(equity)) return null;
  return { time, equity };
}

export function equitySeriesFrom(payload: unknown, session: SessionSummary): ChartEquitySeries[] {
  const rawSeries = listFrom<Record<string, unknown>>(payload, ["series"]);
  if (rawSeries.length) {
    return rawSeries.flatMap((series, index) => {
      const points = Array.isArray(series.points) ? series.points.map(pointFrom).filter((point) => point !== null) : [];
      if (!points.length) return [];
      return [{
        id: String(series.id ?? `series-${index}`),
        label: String(series.label ?? session.name),
        kind: series.kind === "control" || series.kind === "cash" ? series.kind : "strategy",
        points
      }];
    });
  }
  const points = listFrom<unknown>(payload, ["points", "equity", "snapshots"]).map(pointFrom).filter((point) => point !== null);
  return points.length ? [{ id: session.id, label: session.name, kind: "strategy", points }] : [];
}

export async function fetchSessionEquity(id: string) {
  return api.get<unknown>(`/sessions/${encodeURIComponent(id)}/equity?resolution=800`);
}

export async function fetchComparison(ids: string[]) {
  const payload = await api.get<unknown>(`/sessions/compare?ids=${encodeURIComponent(ids.join(","))}`);
  const source = objectAt<Record<string, unknown>>(payload, "comparison");
  const supplied = listFrom<Record<string, unknown>>(source, ["sessions"]);
  const rawEntries = supplied.some((item) => item.session && typeof item.session === "object")
    ? supplied
    : listFrom<Record<string, unknown>>(source, ["details"]);
  const sessions = rawEntries.map((entry): SessionComparisonEntry => {
    const session = objectAt<SessionSummary>(entry, "session");
    const equity = listFrom<EquityPoint>(entry.equity, ["points", "equity"]);
    const normalizedEquity = listFrom<Record<string, unknown>>(entry.normalizedEquity, ["points"]).flatMap((point) => {
      const at = Number(point.at ?? point.time);
      const value = Number(point.value ?? point.equity);
      return Number.isFinite(at) && Number.isFinite(value) ? [{ at, value } satisfies NormalizedEquityPoint] : [];
    });
    const metrics = entry.metrics && typeof entry.metrics === "object" ? entry.metrics as SessionComparisonEntry["metrics"] : session.metrics;
    return { session: { ...session, metrics: metrics ?? undefined }, metrics, equity, normalizedEquity };
  });
  return {
    sessions,
    metricMatrix: source.metricMatrix && typeof source.metricMatrix === "object" ? source.metricMatrix as SessionCompare["metricMatrix"] : undefined,
    configDiff: source.configDiff && typeof source.configDiff === "object" ? source.configDiff as SessionCompare["configDiff"] : undefined
  } satisfies SessionCompare;
}

export function tradesForChart(orders: SessionOrder[]): ChartTrade[] {
  return orders.filter((order) => order.fills.length > 0).map((order) => ({
    id: order.id,
    time: order.filledAt ?? order.submittedAt,
    side: order.side,
    price: order.filledAvgPrice ?? undefined,
    quantity: order.qty,
    label: `${order.side.toUpperCase()} ${order.symbol}`,
    reason: order.signalReason ?? undefined
  }));
}

export function risksForChart(events: ActivityItem[]): ChartRiskEvent[] {
  return events.filter((event) => event.severity === "warn" || event.severity === "block" || event.severity === "halt").map((event) => ({
    id: event.id,
    time: event.at,
    label: event.title ?? event.detail ?? event.type,
    severity: event.severity
  }));
}
