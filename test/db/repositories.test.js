import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";

test("repositories persist and hydrate the core trading records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-repositories-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);

  try {
    await migrate(client);
    const repositories = createRepositories(client);

    const account = await repositories.accounts.create({
      id: "account-1",
      name: "Paper account",
      mode: "paper",
      startingCash: 10_000_000,
      createdAt: 100
    });
    assert.equal(account.cash, 10_000_000);
    assert.equal((await repositories.accounts.adjustBalances("account-1", { cashDelta: -50_000 })).cash, 9_950_000);
    assert.equal(await repositories.accounts.adjustBalances("account-1", { cashDelta: -20_000_000 }), null);

    await repositories.settings.set({ key: "provider", value: "alpaca", updatedAt: 110 });
    await repositories.settings.setMany([
      { key: "api_key", value: "secret", isSecret: true },
      { key: "theme", value: "dark" }
    ], { updatedAt: 111 });
    assert.deepEqual(await repositories.settings.get("api_key"), {
      key: "api_key",
      value: "secret",
      isSecret: true,
      updatedAt: 111
    });

    await repositories.algorithms.create({
      id: "algorithm-1",
      name: "EMA Cross",
      sourcePath: "algorithms/ema-cross.js",
      createdAt: 120
    });
    const version = await repositories.algorithms.addVersion({
      id: "version-1",
      algorithmId: "algorithm-1",
      sourceHash: "sha256-one",
      sourceCode: "export default {};",
      params: { fast: 9, slow: 21 },
      createdAt: 121
    });
    const duplicateVersion = await repositories.algorithms.addVersion({
      id: "version-duplicate",
      algorithmId: "algorithm-1",
      sourceHash: "sha256-one",
      sourceCode: "different ignored source",
      params: {},
      createdAt: 122
    });
    assert.equal(duplicateVersion.id, version.id);
    assert.deepEqual(version.paramsJson, { fast: 9, slow: 21 });

    const session = await repositories.sessions.create({
      id: "session-1",
      accountId: "account-1",
      name: "EMA Cross NVDA",
      mode: "paper",
      status: "draft",
      algorithmVersionId: "version-1",
      params: { fast: 9, slow: 21 },
      symbols: ["NVDA"],
      barInterval: "5min",
      fillModel: { rule: "next_open", slippageBps: 5 },
      riskProfile: { maxDailyLoss: 3 },
      startingEquity: 9_950_000,
      createdAt: 130
    });
    assert.deepEqual(session.symbolsJson, ["NVDA"]);
    assert.deepEqual(session.fillModelJson, { rule: "next_open", slippageBps: 5 });
    assert.equal(
      (await repositories.sessions.transition("session-1", "running", { from: "draft", startedAt: 131 })).status,
      "running"
    );
    assert.equal(await repositories.sessions.transition("session-1", "paused", { from: "draft" }), null);

    const metrics = await repositories.sessions.upsertMetrics({
      id: "metrics-1",
      sessionId: "session-1",
      metricsVersion: "v1",
      computedAt: 140,
      returnPercent: 1.5,
      finalEquity: 10_099_250,
      maxDrawdown: 0.8,
      profitFactor: null,
      winRate: null,
      tradeCount: 1
    });
    assert.equal(metrics.profitFactor, null);
    assert.equal(metrics.winRate, null);

    await repositories.sessions.addEquitySnapshot({
      sessionId: "session-1",
      at: 150,
      equity: 10_000_000,
      cash: 9_000_000,
      positionValue: 1_000_000,
      drawdownPercent: 0
    });
    await repositories.sessions.addEquitySnapshot({
      sessionId: "session-1",
      at: 150,
      equity: 10_010_000,
      cash: 9_000_000,
      positionValue: 1_010_000,
      drawdownPercent: 0
    });
    assert.equal((await repositories.sessions.getEquity("session-1"))[0].equity, 10_010_000);

    const order = await repositories.orders.create({
      id: "order-1",
      clientOrderId: "client-order-1",
      sessionId: "session-1",
      accountId: "account-1",
      symbol: "NVDA",
      side: "buy",
      qty: 1_000_000,
      status: "pending",
      signalReason: "EMA9 crossed above EMA21",
      submittedAt: 160
    });
    const duplicateOrder = await repositories.orders.create({
      id: "order-duplicate",
      clientOrderId: "client-order-1",
      accountId: "account-1",
      symbol: "NVDA",
      side: "buy",
      qty: 1_000_000,
      status: "pending",
      submittedAt: 161
    });
    assert.equal(duplicateOrder.id, order.id);

    const recorded = await repositories.orders.recordFill(
      {
        id: "fill-1",
        orderId: "order-1",
        qty: 1_000_000,
        price: 12_345,
        referencePrice: 12_340,
        commission: 100,
        filledAt: 170,
        quoteAgeMs: 250
      },
      { orderStatus: "filled" }
    );
    assert.equal(recorded.order.status, "filled");
    assert.equal((await repositories.orders.listFills({ sessionId: "session-1" }))[0].price, 12_345);

    await repositories.orders.createPositionLot({
      id: "lot-1",
      sessionId: "session-1",
      accountId: "account-1",
      symbol: "NVDA",
      qtyOpen: 1_000_000,
      qtyOriginal: 1_000_000,
      entryPrice: 12_345,
      entryOrderId: "order-1",
      openedAt: 170
    });
    assert.equal((await repositories.orders.listOpenLots("account-1")).length, 1);
    await repositories.orders.closePositionLot("lot-1", {
      exitPrice: 12_500,
      exitOrderId: "order-1",
      realizedPnl: 15_500,
      closedAt: 180
    });
    assert.equal((await repositories.orders.listOpenLots("account-1")).length, 0);

    await repositories.risk.upsertProfile({
      id: "risk-1",
      accountId: "account-1",
      name: "Default",
      rules: { maxDailyLoss: 3 },
      isDefault: true,
      updatedAt: 190
    });
    await repositories.risk.upsertProfile({
      id: "risk-2",
      accountId: "account-1",
      name: "Conservative",
      rules: { maxDailyLoss: 2 },
      isDefault: true,
      updatedAt: 191
    });
    const profiles = await repositories.risk.listProfiles("account-1");
    assert.equal(profiles.find((profile) => profile.id === "risk-1").isDefault, false);
    assert.equal(profiles.find((profile) => profile.id === "risk-2").isDefault, true);

    const riskEvent = await repositories.risk.addEvent({
      id: "risk-event-1",
      sessionId: "session-1",
      accountId: "account-1",
      orderId: "order-1",
      at: 200,
      ruleId: "quote_freshness",
      severity: "block",
      actionTaken: "order_rejected",
      detail: { observed: 8_200, threshold: 5_000 }
    });
    assert.deepEqual(riskEvent.detailJson, { observed: 8_200, threshold: 5_000 });

    const alert = await repositories.alerts.create({
      id: "alert-1",
      accountId: "account-1",
      name: "Any block",
      triggerType: "risk_event",
      condition: { minimumSeverity: "block" },
      channel: "in_app",
      cooldownMs: 60_000,
      createdAt: 210
    });
    assert.deepEqual(alert.conditionJson, { minimumSeverity: "block" });
    await repositories.alerts.addDelivery({
      id: "delivery-1",
      alertId: "alert-1",
      sessionId: "session-1",
      at: 220,
      status: "sent",
      payload: { riskEventId: "risk-event-1" }
    });
    const feed = await repositories.alerts.feed("account-1");
    assert.equal(feed[0].alertName, "Any block");
    assert.deepEqual(feed[0].payloadJson, { riskEventId: "risk-event-1" });

    const audit = await repositories.audit.append({
      id: "audit-1",
      at: 230,
      actor: "risk_engine",
      action: "order_rejected",
      entity: "order",
      entityId: "order-1",
      detail: { ruleId: "quote_freshness" }
    });
    assert.deepEqual(audit.detailJson, { ruleId: "quote_freshness" });
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

