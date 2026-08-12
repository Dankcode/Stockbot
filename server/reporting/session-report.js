const COMPARABLE_CONFIG_KEYS = Object.freeze([
  ["algorithmVersionId", "Algorithm version"],
  ["paramsJson", "Parameters"],
  ["symbolsJson", "Symbols"],
  ["barInterval", "Bar interval"],
  ["fillModelJson", "Fill model"],
  ["riskProfileJson", "Risk profile"]
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function normalizeEquity(points) {
  const start = Number(points[0]?.equity || 0);
  if (start <= 0) return [];
  return points.map((point) => ({ time: point.at ?? point.time, value: (Number(point.equity) / start) * 100 }));
}

export function downsampleEquity(points, resolution = 1_000) {
  const limit = Math.max(2, Math.min(10_000, Number(resolution) || 1_000));
  if (points.length <= limit) return points;
  const result = [points[0]];
  const interior = limit - 2;
  for (let index = 1; index <= interior; index += 1) {
    const sourceIndex = Math.round((index / (interior + 1)) * (points.length - 1));
    result.push(points[sourceIndex]);
  }
  result.push(points.at(-1));
  return result;
}

export function buildConfigDiff(sessions) {
  return COMPARABLE_CONFIG_KEYS.flatMap(([key, label]) => {
    const values = sessions.map((session) => session[key]);
    return new Set(values.map(stable)).size > 1 ? [{ key, label, values }] : [];
  });
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows) {
  if (!rows.length) return "";
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  return `${columns.map(csvCell).join(",")}\r\n${rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\r\n")}\r\n`;
}

/** A single RFC-4180-compatible export for the session's primary order table. */
export function sessionCsv(report) {
  return rowsToCsv((report.orders || []).map((order) => ({
    session_id: report.session.id,
    order_id: order.id,
    submitted_at: order.submittedAt,
    symbol: order.symbol,
    side: order.side,
    status: order.status,
    qty_microshares: order.qty,
    reject_reason: order.rejectReason,
    signal_reason: order.signalReason
  })));
}
