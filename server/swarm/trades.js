/**
 * Turns a sleeve's fills into closed round trips (FIFO per symbol) and P&L per
 * symbol. Pure. Prices are cents, quantities micro-shares, as in the ledger.
 */
import { nyDate } from "./calendar.js";

const MICRO = 1_000_000;

/**
 * @param {Array} fills         accountFills() rows, oldest first
 * @param {Map}   intentsByOrder orderId -> { entryFeaturesJson, rationale, score }
 * @returns {{ closed: Array, open: Array }}
 */
export function roundTrips(fills, intentsByOrder = new Map()) {
  const lots = new Map();
  const closed = [];
  for (const fill of fills) {
    const queue = lots.get(fill.symbol) ?? [];
    lots.set(fill.symbol, queue);
    const perShareCommission = fill.qty > 0 ? fill.commission / fill.qty : 0;
    if (fill.side === "buy") {
      const intent = intentsByOrder.get(fill.orderId);
      queue.push({
        symbol: fill.symbol, qty: fill.qty, price: fill.price, commissionPerQty: perShareCommission, at: fill.filledAt,
        entry: intent?.entryFeaturesJson ?? null, rationale: intent?.rationale ?? null, decisionScore: intent?.score ?? null
      });
      continue;
    }
    let remaining = fill.qty;
    while (remaining > 0 && queue.length) {
      const lot = queue[0];
      const qty = Math.min(remaining, lot.qty);
      const cost = (lot.price * qty) / MICRO + lot.commissionPerQty * qty;
      const proceeds = (fill.price * qty) / MICRO - perShareCommission * qty;
      closed.push({
        symbol: fill.symbol,
        qty,
        entryAt: lot.at,
        exitAt: fill.filledAt,
        entryDate: nyDate(lot.at),
        exitDate: nyDate(fill.filledAt),
        entryPrice: lot.price,
        exitPrice: fill.price,
        pnlCents: proceeds - cost,
        returnPct: cost > 0 ? Number(((proceeds / cost - 1) * 100).toFixed(6)) : null,
        holdDays: (fill.filledAt - lot.at) / 86_400_000,
        source: lot.entry?.source ?? null,
        lens: lot.entry?.lens ?? null,
        features: lot.entry?.features ?? null,
        rationale: lot.rationale,
        decisionScore: lot.decisionScore
      });
      lot.qty -= qty;
      remaining -= qty;
      if (lot.qty === 0) queue.shift();
    }
  }
  const open = [...lots.values()].flat();
  return { closed, open };
}

/** Realized + unrealized P&L per symbol in cents: sells − buys − commissions + what is still held at its last mark. */
export function pnlBySymbol(fills, positions = []) {
  const pnl = new Map();
  for (const fill of fills) {
    const notional = (fill.price * fill.qty) / MICRO;
    const delta = (fill.side === "sell" ? notional : -notional) - fill.commission;
    pnl.set(fill.symbol, (pnl.get(fill.symbol) ?? 0) + delta);
  }
  for (const position of positions) {
    if (Number.isFinite(Number(position.marketValue))) pnl.set(position.symbol, (pnl.get(position.symbol) ?? 0) + Number(position.marketValue));
  }
  return pnl;
}

/** Buy + sell notional in cents. */
export function tradedNotional(fills) {
  return fills.reduce((sum, fill) => sum + (fill.price * fill.qty) / MICRO, 0);
}
