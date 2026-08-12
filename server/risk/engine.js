import { marketSession } from "./market-hours.js";
import { mergeRiskProfile } from "./profile.js";

function verdict(ruleId, severity, message, observed, threshold, action = severity === "halt" ? "session_halted" : "order_rejected") {
  return { triggered: true, ruleId, severity, action, message, observed, threshold };
}

export function createRiskEngine(baseProfile) {
  const profile = mergeRiskProfile(baseProfile);

  function sizeOrder({ signal, price, equity, cash, atr, stopLossPercent, currentNotional = 0 }) {
    if (signal !== "buy") return { qty: 0, reason: "Exit size is determined by the open position." };
    const maxPosition = equity * (profile.rules.maxPositionSize.percentOfEquity / 100);
    const stopPercent = Number(stopLossPercent ?? profile.rules.positionStopLoss.percent) / 100;
    const stopDistance = Math.max(Number(atr || 0), price * stopPercent, price * 0.001);
    const riskBudget = equity * (profile.sizing.perTradeRiskPercent / 100);
    const fixedFractionalQty = Math.max(0, maxPosition - currentNotional) / price;
    const riskParityQty = riskBudget / stopDistance;
    const fixedNotionalQty = profile.sizing.fixedNotional / price;
    const cashQty = cash / price;
    let qty;
    if (profile.sizing.mode === "fixed_notional") qty = fixedNotionalQty;
    else if (profile.sizing.mode === "fixed_fractional") qty = fixedFractionalQty;
    else qty = Math.min(fixedFractionalQty, riskParityQty);
    if (profile.rules.maxPositionNotional.enabled && profile.rules.maxPositionNotional.amount) {
      qty = Math.min(qty, profile.rules.maxPositionNotional.amount / price);
    }
    qty = Math.max(0, Math.min(qty, cashQty));
    return { qty: Math.floor(qty * 1_000_000) / 1_000_000, riskBudget, stopDistance, mode: profile.sizing.mode };
  }

  function preTrade(ctx) {
    const rules = profile.rules;
    const failures = [];
    const quoteAge = Math.max(0, ctx.now - ctx.quote.at);
    if (rules.quoteFreshness.enabled && quoteAge > rules.quoteFreshness.maxAgeMs) {
      failures.push(verdict("quote_freshness", "block", `Quote is ${quoteAge}ms old.`, quoteAge, rules.quoteFreshness.maxAgeMs));
    }
    const market = marketSession(ctx.symbol, ctx.now);
    if (rules.marketHours.enabled && !market.open) {
      failures.push(verdict("market_hours", "block", `Market is closed (${market.reason}).`, market.reason, "open"));
    }
    if (ctx.side === "buy" && rules.priceSanity.enabled) {
      const comparisons = [];
      if (Number(ctx.priorPrice) > 0) {
        comparisons.push({
          label: "prior fresh tick",
          move: Math.abs((ctx.quote.price - ctx.priorPrice) / ctx.priorPrice) * 100
        });
      }
      if (Number(ctx.referencePrice) > 0) {
        comparisons.push({
          label: "modeled next open",
          move: Math.abs((ctx.referencePrice - ctx.quote.price) / ctx.quote.price) * 100
        });
      }
      const breached = comparisons.sort((left, right) => right.move - left.move)[0];
      if (breached?.move > rules.priceSanity.maxMovePercent) {
        failures.push(verdict(
          "price_sanity",
          "block",
          `Price differs from the ${breached.label} beyond the sanity band.`,
          breached.move,
          rules.priceSanity.maxMovePercent
        ));
      }
    }
    const notional = ctx.qty * ctx.quote.price;
    if (rules.minOrderNotional.enabled && notional < rules.minOrderNotional.amount) failures.push(verdict("min_order_notional", "block", "Order is below the minimum notional.", notional, rules.minOrderNotional.amount));
    if (ctx.side === "buy" && rules.sufficientFunds.enabled && notional + (ctx.estimatedCommission || 0) > ctx.cash) failures.push(verdict("sufficient_funds", "block", "Order exceeds available cash.", notional, ctx.cash));
    if (ctx.side === "buy" && rules.maxConcurrentPositions.enabled && !ctx.hasPosition && ctx.openPositionCount >= rules.maxConcurrentPositions.count) failures.push(verdict("max_concurrent_positions", "block", "Concurrent position limit reached.", ctx.openPositionCount, rules.maxConcurrentPositions.count));
    const symbolExposure = ((ctx.symbolNotional + (ctx.side === "buy" ? notional : -notional)) / Math.max(ctx.equity, 1)) * 100;
    if (ctx.side === "buy" && rules.maxSymbolExposure.enabled && symbolExposure > rules.maxSymbolExposure.percentOfEquity) failures.push(verdict("max_symbol_exposure", "block", "Symbol exposure limit exceeded.", symbolExposure, rules.maxSymbolExposure.percentOfEquity));
    if (rules.maxOrdersPerMinute.enabled && ctx.ordersLastMinute >= rules.maxOrdersPerMinute.count) failures.push(verdict("max_orders_per_minute", "block", "Order rate limit reached.", ctx.ordersLastMinute, rules.maxOrdersPerMinute.count));
    if (rules.maxOrdersPerDay.enabled && ctx.ordersToday >= rules.maxOrdersPerDay.count) failures.push(verdict("max_orders_per_day", "block", "Daily order limit reached.", ctx.ordersToday, rules.maxOrdersPerDay.count));
    return failures;
  }

  function continuous(ctx) {
    const rules = profile.rules;
    const failures = [];
    const dailyBaseline = Number(ctx.dayStartEquity ?? ctx.startingEquity);
    const dailyLossPercent = dailyBaseline > 0 ? Math.max(0, ((dailyBaseline - ctx.equity) / dailyBaseline) * 100) : 0;
    if (rules.maxDailyLoss.enabled && dailyLossPercent >= rules.maxDailyLoss.percentOfStartingEquity) failures.push(verdict("max_daily_loss", "halt", "Daily loss allowance exhausted.", dailyLossPercent, rules.maxDailyLoss.percentOfStartingEquity));
    const drawdown = ctx.peakEquity > 0 ? Math.max(0, ((ctx.peakEquity - ctx.equity) / ctx.peakEquity) * 100) : 0;
    if (rules.maxDrawdown.enabled && drawdown >= rules.maxDrawdown.percentFromPeak) failures.push(verdict("max_drawdown", "halt", "Session drawdown limit reached.", drawdown, rules.maxDrawdown.percentFromPeak));
    const accountDrawdown = ctx.accountPeakEquity > 0 ? Math.max(0, ((ctx.accountPeakEquity - ctx.accountEquity) / ctx.accountPeakEquity) * 100) : 0;
    if (rules.maxAccountDrawdown.enabled && accountDrawdown >= rules.maxAccountDrawdown.percentFromPeak) failures.push(verdict("max_account_drawdown", "halt", "Account drawdown limit reached.", accountDrawdown, rules.maxAccountDrawdown.percentFromPeak, "account_halted"));
    const exposure = ctx.equity > 0 ? (ctx.positionValue / ctx.equity) * 100 : 0;
    if (rules.maxExposure.enabled && exposure >= rules.maxExposure.blockPercent) failures.push(verdict("max_exposure", "block", "Account exposure is above the hard limit.", exposure, rules.maxExposure.blockPercent, "new_entries_blocked"));
    else if (rules.maxExposure.enabled && exposure >= rules.maxExposure.warnPercent) failures.push(verdict("max_exposure", "warn", "Account exposure is above the warning threshold.", exposure, rules.maxExposure.warnPercent, "logged"));
    const dataAge = Math.max(0, ctx.now - ctx.latestQuoteAt);
    if (rules.dataStaleness.enabled && dataAge > rules.dataStaleness.maxAgeMs) failures.push(verdict("data_staleness", "warn", "Market data is stale; session should pause.", dataAge, rules.dataStaleness.maxAgeMs, "session_paused"));
    return failures;
  }

  function protectiveExits(ctx) {
    const exits = new Map();
    for (const position of ctx.positions ?? []) {
      const price = Number(position.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      for (const lot of position.lots ?? []) {
        const entryPrice = Number(lot.entryPrice);
        const qty = Number(lot.qty);
        if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isSafeInteger(qty) || qty <= 0) continue;
        const lossPercent = ((entryPrice - price) / entryPrice) * 100;
        const gainPercent = ((price - entryPrice) / entryPrice) * 100;
        let ruleId = null;
        let observed = null;
        let threshold = null;
        if (profile.rules.positionStopLoss.enabled && lossPercent >= Number(profile.rules.positionStopLoss.percent)) {
          ruleId = "position_stop_loss";
          observed = lossPercent;
          threshold = Number(profile.rules.positionStopLoss.percent);
        } else if (
          profile.rules.positionTakeProfit?.enabled &&
          Number(profile.rules.positionTakeProfit.percent) > 0 &&
          gainPercent >= Number(profile.rules.positionTakeProfit.percent)
        ) {
          ruleId = "position_take_profit";
          observed = gainPercent;
          threshold = Number(profile.rules.positionTakeProfit.percent);
        }
        if (!ruleId) continue;
        const key = `${ruleId}:${position.symbol}`;
        const exit = exits.get(key) ?? {
          triggered: true,
          ruleId,
          severity: "warn",
          action: "position_exit",
          symbol: position.symbol,
          qty: 0,
          lotIds: [],
          observed: 0,
          threshold,
          message: ruleId === "position_stop_loss" ? "Position stop-loss triggered." : "Position take-profit triggered."
        };
        exit.qty += qty;
        exit.lotIds.push(lot.id);
        exit.observed = Math.max(exit.observed, observed);
        exits.set(key, exit);
      }
    }
    return [...exits.values()];
  }

  return { profile, sizeOrder, preTrade, continuous, protectiveExits };
}
