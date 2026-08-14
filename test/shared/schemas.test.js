import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  ApiEnvelopeSchema,
  BarSchema,
  MarketQuoteSchema,
  MetricsSchema,
  OrderSchema,
  RiskRuleSchema,
  SessionSchema,
  createApiEnvelopeSchema,
  createErrorEnvelopeSchema,
  createSuccessEnvelopeSchema
} from "../../packages/shared/schemas.js";

const validMetrics = {
  returnPercent: 2.4,
  finalEquity: 102_400_00,
  maxDrawdown: 4.1,
  sharpe: 1.2,
  sortino: null,
  profitFactor: null,
  winRate: null,
  tradeCount: 0,
  exposurePercent: 32,
  avgTradePercent: null
};

test("bar schema accepts coherent OHLC data and rejects impossible bars", () => {
  const bar = { time: 1_786_200_000_000, open: 100, high: 102, low: 99, close: 101, volume: 10_000 };
  assert.deepEqual(BarSchema.parse(bar), bar);
  assert.equal(BarSchema.safeParse({ ...bar, high: 100 }).success, false);
  assert.equal(BarSchema.safeParse({ ...bar, low: 101.5 }).success, false);
  assert.equal(BarSchema.safeParse({ ...bar, invented: true }).success, false);
});

test("quote contract represents unavailable data explicitly", () => {
  assert.equal(
    MarketQuoteSchema.safeParse({
      symbol: "NVDA",
      status: "unavailable",
      error: "provider timeout",
      checkedAt: 1_786_200_000_000
    }).success,
    true
  );
  assert.equal(MarketQuoteSchema.safeParse({ symbol: "NVDA", price: 0 }).success, false);
});

test("metrics preserve null and require positive drawdown magnitude", () => {
  assert.deepEqual(MetricsSchema.parse(validMetrics), validMetrics);
  assert.equal(MetricsSchema.safeParse({ ...validMetrics, maxDrawdown: -4.1 }).success, false);
  assert.equal(MetricsSchema.safeParse({ ...validMetrics, winRate: 101 }).success, false);
});

test("orders validate integer micro-shares, limit prices, and chronology", () => {
  const order = {
    id: "order-1",
    clientOrderId: "client-1",
    sessionId: "session-1",
    researchSnapshotId: null,
    accountId: "account-1",
    symbol: "AAPL",
    side: "buy",
    orderType: "market",
    qty: 1_500_000,
    limitPrice: null,
    status: "pending",
    rejectReason: null,
    signalReason: "EMA crossover",
    signalBarAt: 1_786_199_700_000,
    submittedAt: 1_786_200_000_000,
    resolvedAt: null
  };
  assert.deepEqual(OrderSchema.parse(order), order);
  assert.equal(OrderSchema.safeParse({ ...order, qty: 1.5 }).success, false);
  assert.equal(OrderSchema.safeParse({ ...order, orderType: "limit" }).success, false);
  assert.equal(OrderSchema.safeParse({ ...order, resolvedAt: order.submittedAt - 1 }).success, false);
  assert.equal(OrderSchema.safeParse({ ...order, signalBarAt: order.submittedAt + 1 }).success, false);
});

test("session and risk contracts enforce lifecycle vocabulary and time order", () => {
  const session = {
    id: "session-1",
    accountId: "account-1",
    name: "EMA on NVDA",
    mode: "paper",
    status: "draft",
    algorithmVersionId: "version-1",
    researchPlanVersionId: null,
    params: {},
    symbols: ["NVDA"],
    barInterval: "5min",
    windowStart: 1_000,
    windowEnd: 2_000,
    fillModel: { rule: "next_bar_open" },
    riskProfile: {},
    schedule: {},
    startingEquity: 10_000_000,
    endingEquity: null,
    startedAt: null,
    endedAt: null,
    stopReason: null,
    errorDetail: null,
    createdAt: 500
  };
  assert.deepEqual(SessionSchema.parse(session), session);
  assert.equal(SessionSchema.safeParse({ ...session, windowEnd: 999 }).success, false);
  assert.equal(SessionSchema.safeParse({ ...session, status: "done" }).success, false);

  assert.equal(
    RiskRuleSchema.safeParse({
      id: "max_daily_loss",
      scope: "session",
      phase: "continuous",
      severity: "halt",
      enabled: true,
      threshold: 3,
      config: {}
    }).success,
    true
  );
});

test("success and error envelope factories retain payload-specific schemas", () => {
  const successSchema = createSuccessEnvelopeSchema(z.array(z.string()));
  assert.deepEqual(successSchema.parse({ data: ["AAPL"], meta: { requestId: "req-1" } }), {
    data: ["AAPL"],
    meta: { requestId: "req-1" }
  });
  assert.equal(successSchema.safeParse({ data: [1], meta: {} }).success, false);
  assert.equal(successSchema.safeParse({ data: ["AAPL"], meta: {}, extra: true }).success, false);

  const errorSchema = createErrorEnvelopeSchema(z.object({ provider: z.string() }).strict());
  assert.equal(
    errorSchema.safeParse({
      error: { code: "MARKET_UNAVAILABLE", message: "No provider responded", detail: { provider: "all" } }
    }).success,
    true
  );
  assert.equal(
    errorSchema.safeParse({
      error: { code: "MARKET_UNAVAILABLE", message: "No provider responded", detail: { provider: 1 } }
    }).success,
    false
  );
});

test("API envelope union cannot ambiguously contain success and error", () => {
  assert.equal(ApiEnvelopeSchema.safeParse({ data: {}, meta: {} }).success, true);
  assert.equal(ApiEnvelopeSchema.safeParse({ error: { code: "NO_DATA", message: "No bars" } }).success, true);
  assert.equal(
    ApiEnvelopeSchema.safeParse({ data: {}, meta: {}, error: { code: "NO_DATA", message: "No bars" } }).success,
    false
  );

  const typed = createApiEnvelopeSchema(z.object({ id: z.string() }).strict());
  assert.equal(typed.safeParse({ data: { id: "session-1" }, meta: {} }).success, true);
  assert.equal(typed.safeParse({ data: { id: 1 }, meta: {} }).success, false);
});
