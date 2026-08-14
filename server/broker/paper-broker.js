import { randomUUID } from "node:crypto";
import { calculateFill, normalizeFillModel } from "../engine/fill-model.js";
import { dollarsToCents } from "./ledger.js";

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return number;
}

function startOfUtcDay(at) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function createPaperBroker({
  ledger,
  market,
  riskEngine = null,
  fillModel: defaultFillModel,
  quoteFreshnessMs = 5_000,
  eventHub,
  riskEventRecorder,
  clock = () => Date.now(),
  idFactory = randomUUID
}) {
  if (!ledger || !market?.getQuote) throw new TypeError("Paper broker requires ledger and market services.");
  const baseFillModel = normalizeFillModel(defaultFillModel);
  const recentQuotes = new Map();

  function rememberQuote(symbol, quote) {
    if (quote?.status !== "real" || !Number.isFinite(Number(quote.price)) || !Number.isFinite(Number(quote.at))) return;
    const tick = { price: Number(quote.price), at: Number(quote.at) };
    const history = recentQuotes.get(symbol) ?? [];
    if (history[0]?.price === tick.price && history[0]?.at === tick.at) return;
    recentQuotes.set(symbol, [tick, ...history].slice(0, 4));
  }

  function priorFreshTick(symbol, quote, now) {
    return (recentQuotes.get(symbol) ?? []).find((tick) =>
      tick.at <= now && now - tick.at <= quoteFreshnessMs &&
      !(tick.at === Number(quote.at) && tick.price === Number(quote.price))
    ) ?? null;
  }

  async function portfolio(accountId, { fresh = false, at = clock(), sessionId = null, rememberQuotes = true } = {}) {
    const open = await ledger.listOpenPositions(accountId, { sessionId });
    const quotes = new Map();
    await Promise.all(
      open.map(async ({ symbol }) => {
        try {
          const quote = await market.getQuote(symbol, { fresh });
          quotes.set(symbol, quote);
          if (rememberQuotes) rememberQuote(symbol, quote);
        } catch (error) {
          quotes.set(symbol, { symbol, status: "unavailable", error: error.message, checkedAt: at });
        }
      })
    );
    return ledger.portfolio(accountId, { quotes, at, sessionId });
  }

  async function rejectFor(input, code, message, detail) {
    const execution = await ledger.rejectOrder({
      ...input,
      rejectReason: code,
      submittedAt: input.submittedAt ?? clock()
    });
    eventHub?.publish("order.rejected", { order: execution.order, code, message, detail });
    return { ...execution, rejection: { code, message, detail } };
  }

  async function submitOrder(input) {
    if (!input?.clientOrderId) throw new TypeError("clientOrderId is required.");
    if (!input?.accountId) throw new TypeError("accountId is required.");
    if (input.side !== "buy" && input.side !== "sell") throw new TypeError("side must be buy or sell.");
    const qty = positiveInteger(input.qty, "qty");
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    if (!symbol) throw new TypeError("symbol is required.");

    const existing = await ledger.getExecution(input.clientOrderId, { ...input, symbol, qty });
    if (existing && existing.order.status !== "pending") return existing;

    const now = input.submittedAt ?? clock();
    let quote;
    try {
      quote = input.quote ?? (await market.getQuote(symbol, { fresh: true }));
    } catch (error) {
      return rejectFor({ ...input, symbol, qty }, "market_data_unavailable", error.message);
    }
    if (quote?.status !== "real" || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0) {
      return rejectFor(
        { ...input, symbol, qty },
        "market_data_unavailable",
        "A fresh real quote is required.",
        { status: quote?.status }
      );
    }
    const priorTick = priorFreshTick(symbol, quote, now);
    const quoteAgeMs = Math.max(0, now - Number(quote.at));
    if (!Number.isFinite(Number(quote.at)) || quoteAgeMs > quoteFreshnessMs) {
      return rejectFor(
        { ...input, symbol, qty },
        "quote_freshness",
        `Quote is ${quoteAgeMs}ms old.`,
        { observed: quoteAgeMs, threshold: quoteFreshnessMs }
      );
    }

    const model = normalizeFillModel({ ...baseFillModel, ...(input.fillModel ?? {}) });
    const modeledReferencePrice = input.referencePrice ?? quote.price;
    if (!Number.isFinite(Number(modeledReferencePrice)) || Number(modeledReferencePrice) <= 0) {
      return rejectFor(
        { ...input, symbol, qty },
        "invalid_reference_price",
        "The next bar open must be a positive real price."
      );
    }
    const modeled = calculateFill(
      { side: input.side, quantity: qty / 1_000_000, referencePrice: Number(modeledReferencePrice) },
      model
    );
    const referencePrice = dollarsToCents(modeledReferencePrice);
    const fillPrice = dollarsToCents(modeled.price);
    const commission = Math.max(0, Math.round(modeled.commission * 100));

    const activeRisk = input.riskEngine ?? riskEngine;
    if (activeRisk && !input.skipRisk) {
      const accountPortfolio = await portfolio(input.accountId, {
        fresh: false,
        at: now,
        sessionId: input.sessionId ?? null,
        rememberQuotes: false
      });
      const positions = await ledger.listOpenPositions(input.accountId, { sessionId: input.sessionId ?? null });
      const symbolPosition = accountPortfolio.positions.find((position) => position.symbol === symbol);
      const [ordersLastMinute, ordersToday] = await Promise.all([
        ledger.countOrders(input.accountId, now - 60_000),
        ledger.countOrders(input.accountId, startOfUtcDay(now))
      ]);
      const failures = activeRisk.preTrade({
        now,
        symbol,
        side: input.side,
        qty: qty / 1_000_000,
        quote,
        priorPrice: priorTick?.price ?? null,
        referencePrice: Number(modeledReferencePrice),
        cash: accountPortfolio.cash / 100,
        equity: (accountPortfolio.equity ?? accountPortfolio.cash) / 100,
        estimatedCommission: commission / 100,
        hasPosition: Boolean(symbolPosition),
        openPositionCount: positions.length,
        symbolNotional: Number(symbolPosition?.marketValue ?? 0) / 100,
        ordersLastMinute,
        ordersToday
      });
      if (failures.length > 0) {
        if (!failures.some((failure) => failure.ruleId === "price_sanity")) {
          rememberQuote(symbol, quote);
        }
        const rejected = await rejectFor(
          { ...input, symbol, qty },
          failures[0].ruleId,
          failures[0].message,
          { failures }
        );
        if (riskEventRecorder) {
          for (const failure of failures) {
            await riskEventRecorder({ failure, order: rejected.order, accountId: input.accountId, sessionId: input.sessionId });
          }
        }
        return { ...rejected, riskFailures: failures };
      }
    }

    rememberQuote(symbol, quote);

    const execution = await ledger.executeOrder({
      id: input.id ?? idFactory(),
      fillId: input.fillId ?? idFactory(),
      lotId: input.side === "buy" ? input.lotId ?? idFactory() : undefined,
      clientOrderId: input.clientOrderId,
      sessionId: input.sessionId ?? null,
      researchSnapshotId: input.researchSnapshotId ?? null,
      accountId: input.accountId,
      symbol,
      side: input.side,
      qty,
      referencePrice,
      fillPrice,
      commission,
      quoteAgeMs,
      signalReason: input.signalReason ?? null,
      submittedAt: now,
      filledAt: input.filledAt ?? now
    });
    const eventType = execution.order.status === "filled" ? "order.filled" : "order.rejected";
    eventHub?.publish(eventType, { order: execution.order, fills: execution.fills });
    return { ...execution, quote, modeledFill: modeled };
  }

  async function queueOrder(input) {
    if (!input?.clientOrderId) throw new TypeError("clientOrderId is required.");
    if (!input?.accountId) throw new TypeError("accountId is required.");
    if (input.side !== "buy" && input.side !== "sell") throw new TypeError("side must be buy or sell.");
    const qty = positiveInteger(input.qty, "qty");
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    if (!symbol) throw new TypeError("symbol is required.");
    const execution = await ledger.createPendingOrder({
      id: input.id ?? idFactory(),
      clientOrderId: input.clientOrderId,
      sessionId: input.sessionId ?? null,
      researchSnapshotId: input.researchSnapshotId ?? null,
      accountId: input.accountId,
      symbol,
      side: input.side,
      qty,
      signalReason: input.signalReason ?? null,
      signalBarAt: input.signalBarAt ?? null,
      submittedAt: input.submittedAt ?? clock()
    });
    if (!execution.idempotent) eventHub?.publish("order.pending", { order: execution.order });
    return execution;
  }

  async function liquidate(accountId, options = {}) {
    const positions = await ledger.listOpenPositions(accountId, { sessionId: options.sessionId ?? null });
    const operationId = options.operationId ?? idFactory();
    const closed = [];
    const failed = [];
    for (const position of positions) {
      try {
        const result = await submitOrder({
          accountId,
          sessionId: options.sessionId ?? null,
          clientOrderId: `liquidate:${operationId}:${position.symbol}`,
          symbol: position.symbol,
          side: "sell",
          qty: position.qty,
          signalReason: options.reason ?? "Failsafe liquidation",
          skipRisk: true
        });
        if (result.order.status === "filled") closed.push({ symbol: position.symbol, qty: position.qty, ...result });
        else failed.push({ symbol: position.symbol, qty: position.qty, error: result.rejection?.message ?? result.order.rejectReason });
      } catch (error) {
        failed.push({ symbol: position.symbol, qty: position.qty, error: error.message, code: error.code });
      }
    }
    const result = {
      operationId,
      closed,
      failed,
      remaining: await ledger.listOpenPositions(accountId, { sessionId: options.sessionId ?? null })
    };
    eventHub?.publish("account.liquidated", { accountId, ...result });
    return result;
  }

  async function ensureDefaultAccount(options) {
    return ledger.ensureDefaultAccount(options);
  }

  return Object.freeze({ ensureDefaultAccount, queueOrder, submitOrder, portfolio, liquidate });
}
