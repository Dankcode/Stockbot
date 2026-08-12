import { formatMoney, formatPercent, formatQty } from "../../../packages/shared/format.js";
import { DataTable, type DataColumn } from "../../components/data/DataTable";
import type { Position } from "../../lib/types";

const columns: DataColumn<Position>[] = [
  { key: "symbol", header: "Symbol", render: (position) => <strong>{position.symbol}</strong> },
  { key: "side", header: "Side", render: (position) => <span className={(position.side ?? (position.qty < 0 ? "short" : "long")) === "long" ? "positive" : "negative"}>{position.side ?? (position.qty < 0 ? "Short" : "Long")}</span> },
  { key: "qty", header: "Qty", numeric: true, render: (position) => formatQty(Math.abs(position.qty)) },
  { key: "avg", header: "Avg price", numeric: true, render: (position) => formatMoney(position.avgPrice) },
  { key: "last", header: "Last", numeric: true, render: (position) => formatMoney(position.price) },
  { key: "pnl", header: "P&L", numeric: true, render: (position) => <span className={position.unrealizedPnl == null ? "muted" : position.unrealizedPnl >= 0 ? "positive" : "negative"}>{formatMoney(position.unrealizedPnl, { signed: true })}</span> },
  { key: "pnl-percent", header: "P&L %", numeric: true, render: (position) => <span className={(position.unrealizedPnlPercent ?? 0) >= 0 ? "positive" : "negative"}>{formatPercent(position.unrealizedPnlPercent, { signed: true, precision: 2 })}</span> }
];

export function PositionsTable({ positions }: { positions: Position[] }) {
  return <DataTable columns={columns} rows={positions} rowKey={(position) => position.symbol} label="Open positions" />;
}
