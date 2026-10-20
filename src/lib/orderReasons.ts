/** Plain-language explanations for the reject and risk codes the API returns. */
const REASONS: Record<string, string> = {
  missed_next_bar_open: "Missed the next open — the order could not be filled in the opening window",
  quote_freshness: "No fresh price — the latest quote was too old to trade on",
  market_hours: "Market closed when the order was processed",
  market_data_unavailable: "Market data unavailable",
  invalid_reference_price: "No valid opening price",
  price_sanity: "Price moved beyond the sanity band",
  min_order_notional: "Order below the minimum size",
  sufficient_funds: "Not enough cash",
  max_concurrent_positions: "Too many open positions",
  max_symbol_exposure: "Symbol exposure limit reached",
  max_position_size: "Position size limit reached",
  max_orders_per_minute: "Order rate limit reached",
  max_orders_per_day: "Daily order limit reached",
  max_exposure: "Account exposure limit reached",
  max_daily_loss: "Daily loss limit reached",
  max_drawdown: "Drawdown limit reached",
  max_account_drawdown: "Account drawdown limit reached",
  data_staleness: "Market data went stale"
};

export function describeReason(code?: string | null) {
  if (!code) return null;
  return REASONS[code] ?? code.replace(/_/g, " ");
}
