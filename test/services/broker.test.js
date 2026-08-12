import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createLedger } from "../../server/broker/ledger.js";
import { createPaperBroker } from "../../server/broker/paper-broker.js";

const NOW = Date.UTC(2025, 0, 6, 15, 0, 0);

function sequenceIds(prefix = "id") {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

async function harness() {
  const client = await createClient("file::memory:");
  await migrate(client);
  const repositories = createRepositories(client);
  const quotes = new Map();
  const failures = new Set();
  const market = {
    async getQuote(symbol) {
      if (failures.has(symbol)) throw new Error(`No fresh quote for ${symbol}`);
      const price = quotes.get(symbol);
      if (!price) throw new Error(`Missing quote for ${symbol}`);
      return { symbol, status: "real", price, previousClose: price, at: NOW, source: "stub" };
    }
  };
  const idFactory = sequenceIds();
  const ledger = createLedger({ client, repositories, clock: () => NOW, idFactory });
  const broker = createPaperBroker({
    ledger,
    market,
    clock: () => NOW,
    idFactory,
    quoteFreshnessMs: 5_000,
    fillModel: { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 }
  });
  return { client, repositories, quotes, failures, ledger, broker };
}

test("idempotent concurrent buys cannot race account cash below zero", async (t) => {
  const context = await harness();
  t.after(() => context.client.close());
  await context.broker.ensureDefaultAccount({ id: "race", startingCash: 10_000 });
  context.quotes.set("AAPL", 60);

  const [first, second] = await Promise.all([
    context.broker.submitOrder({
      accountId: "race",
      clientOrderId: "buy-1",
      symbol: "AAPL",
      side: "buy",
      qty: 1_000_000
    }),
    context.broker.submitOrder({
      accountId: "race",
      clientOrderId: "buy-2",
      symbol: "AAPL",
      side: "buy",
      qty: 1_000_000
    })
  ]);
  assert.deepEqual(new Set([first.order.status, second.order.status]), new Set(["filled", "rejected"]));
  assert.equal((await context.repositories.accounts.getById("race")).cash, 4_000);

  const filled = [first, second].find((result) => result.order.status === "filled");
  const retry = await context.broker.submitOrder({
    accountId: "race",
    clientOrderId: filled.order.clientOrderId,
    symbol: "AAPL",
    side: "buy",
    qty: 1_000_000
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.order.id, filled.order.id);
  assert.equal((await context.repositories.accounts.getById("race")).cash, 4_000);
});

test("FIFO sells support partial lots and persist exact realized P&L", async (t) => {
  const context = await harness();
  t.after(() => context.client.close());
  await context.broker.ensureDefaultAccount({ id: "fifo", startingCash: 10_000 });

  context.quotes.set("AAPL", 10);
  await context.broker.submitOrder({ accountId: "fifo", clientOrderId: "lot-1", symbol: "AAPL", side: "buy", qty: 2_000_000 });
  context.quotes.set("AAPL", 12);
  await context.broker.submitOrder({ accountId: "fifo", clientOrderId: "lot-2", symbol: "AAPL", side: "buy", qty: 2_000_000 });
  context.quotes.set("AAPL", 15);
  const sale = await context.broker.submitOrder({
    accountId: "fifo",
    clientOrderId: "fifo-sale",
    symbol: "AAPL",
    side: "sell",
    qty: 3_000_000
  });

  assert.equal(sale.order.status, "filled");
  assert.equal(sale.realizedPnl, 1_300);
  const account = await context.repositories.accounts.getById("fifo");
  assert.equal(account.cash, 10_100);
  assert.equal(account.realizedPnl, 1_300);
  const lots = await context.repositories.orders.listOpenLots("fifo");
  assert.equal(lots.length, 1);
  assert.equal(lots[0].entryPrice, 1_200);
  assert.equal(lots[0].qtyOpen, 1_000_000);
});

test("session-owned positions cannot be sold by another session on the same account", async (t) => {
  const context = await harness();
  t.after(() => context.client.close());
  await context.broker.ensureDefaultAccount({ id: "shared-account", startingCash: 20_000 });
  for (const id of ["session-owner", "session-other"]) {
    await context.repositories.sessions.create({
      id,
      accountId: "shared-account",
      name: id,
      mode: "paper",
      status: "running",
      symbols: ["AAPL"],
      barInterval: "1day",
      fillModel: {},
      riskProfile: {},
      schedule: { type: "manual", timezone: "UTC" },
      startingEquity: 20_000,
      createdAt: NOW
    });
  }

  context.quotes.set("AAPL", 10);
  const purchase = await context.broker.submitOrder({
    accountId: "shared-account",
    sessionId: "session-owner",
    clientOrderId: "owned-buy",
    symbol: "AAPL",
    side: "buy",
    qty: 1_000_000
  });
  assert.equal(purchase.order.status, "filled");

  context.quotes.set("AAPL", 12);
  const foreignSale = await context.broker.submitOrder({
    accountId: "shared-account",
    sessionId: "session-other",
    clientOrderId: "foreign-sale",
    symbol: "AAPL",
    side: "sell",
    qty: 1_000_000
  });
  assert.equal(foreignSale.order.status, "rejected");
  assert.equal(foreignSale.order.rejectReason, "insufficient_position");
  assert.equal((await context.ledger.listOpenPositions("shared-account", { sessionId: "session-other" })).length, 0);
  const ownerPositions = await context.ledger.listOpenPositions("shared-account", { sessionId: "session-owner" });
  assert.equal(ownerPositions.length, 1);
  assert.equal(ownerPositions[0].qty, 1_000_000);
});

test("portfolio marks real quotes and derives dayChange from persisted equity", async (t) => {
  const context = await harness();
  t.after(() => context.client.close());
  await context.broker.ensureDefaultAccount({ id: "portfolio", startingCash: 10_000 });
  context.quotes.set("AAPL", 12);
  await context.broker.submitOrder({
    accountId: "portfolio",
    clientOrderId: "portfolio-buy",
    symbol: "AAPL",
    side: "buy",
    qty: 1_000_000
  });
  await context.repositories.sessions.create({
    id: "portfolio-session",
    accountId: "portfolio",
    name: "Portfolio snapshot",
    mode: "paper",
    status: "draft",
    symbols: ["AAPL"],
    barInterval: "1day",
    fillModel: {},
    startingEquity: 10_000,
    createdAt: NOW - 100
  });
  await context.repositories.sessions.addEquitySnapshot({
    sessionId: "portfolio-session",
    at: NOW - 86_400_000,
    equity: 10_200,
    cash: 8_800,
    positionValue: 1_400
  });
  await context.repositories.sessions.addEquitySnapshot({
    sessionId: "portfolio-session",
    at: NOW - 1,
    equity: 9_000,
    cash: 8_800,
    positionValue: 200
  });
  context.quotes.set("AAPL", 15);
  const portfolio = await context.broker.portfolio("portfolio", { fresh: true, at: NOW });
  assert.equal(portfolio.dataStatus, "real");
  assert.equal(portfolio.equity, 10_300);
  assert.equal(portfolio.dayChange, 100);
  assert.equal(portfolio.positions[0].price, 1_500);
  assert.equal(portfolio.positions[0].unrealizedPnl, 300);
  assert.equal(portfolio.positions[0].quoteAgeMs, 0);
});

test("liquidation closes only symbols with successful fresh real quotes", async (t) => {
  const context = await harness();
  t.after(() => context.client.close());
  await context.broker.ensureDefaultAccount({ id: "liquidate", startingCash: 20_000 });
  context.quotes.set("AAPL", 10);
  context.quotes.set("NVDA", 20);
  await context.broker.submitOrder({ accountId: "liquidate", clientOrderId: "aapl-buy", symbol: "AAPL", side: "buy", qty: 1_000_000 });
  await context.broker.submitOrder({ accountId: "liquidate", clientOrderId: "nvda-buy", symbol: "NVDA", side: "buy", qty: 1_000_000 });
  context.quotes.set("AAPL", 11);
  context.failures.add("NVDA");

  const result = await context.broker.liquidate("liquidate", { operationId: "panic" });
  assert.deepEqual(result.closed.map((item) => item.symbol), ["AAPL"]);
  assert.deepEqual(result.failed.map((item) => item.symbol), ["NVDA"]);
  assert.deepEqual(result.remaining.map((item) => item.symbol), ["NVDA"]);
  assert.equal((await context.repositories.orders.getByClientOrderId("liquidate:panic:NVDA")).status, "rejected");
});
