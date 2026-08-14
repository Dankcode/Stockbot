import assert from "node:assert/strict";
import { test } from "node:test";
import { ResearchSnapshotSchema } from "../../packages/shared/research.js";
import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createLedger, DEFAULT_ACCOUNT_ID } from "../../server/broker/ledger.js";
import { createPaperBroker } from "../../server/broker/paper-broker.js";
import { EnginePool } from "../../server/engine/pool.js";
import { researchTimelineHash } from "../../server/research/timeline.js";
import { createSupervisor } from "../../server/runtime/supervisor.js";
import { deterministicBars } from "../engine/fixtures/bars.js";

const START = Date.UTC(2025, 2, 3, 15, 0, 0);
const ALGORITHM_SOURCE = `
export default {
  name: "Supervisor fixture",
  params: { entry: 1, exit: 3 },
  signal({ index, params, position }) {
    if (position.qty === 0 && index === params.entry) {
      return { action: "buy", reason: "fixture entry" };
    }
    if (position.qty > 0 && index === params.exit) {
      return { action: "sell", reason: "fixture exit" };
    }
    return null;
  }
};`;

function sequenceIds(prefix = "service") {
  let value = 1;
  return () => `${prefix}-${value++}`;
}

class FakeScheduler {
  constructor() {
    this.tasks = new Map();
  }

  schedule(id, interval, callback, options = {}) {
    this.tasks.set(id, { interval, callback, options });
  }

  cancel(id) {
    this.tasks.delete(id);
  }

  cancelAll() {
    this.tasks.clear();
  }

  has(id) {
    return this.tasks.has(id);
  }
}

async function harness(t, { researchOverrides } = {}) {
  const client = await createClient("file::memory:");
  await migrate(client);
  const repositories = createRepositories(client);
  const scheduler = new FakeScheduler();
  const events = [];
  const alerts = [];
  const idFactory = sequenceIds();
  let now = START;
  const quotePrices = new Map([["AAPL", 100], ["MSFT", 200]]);
  const marketBars = [...deterministicBars];
  let visibleBarCount = marketBars.length;
  const market = {
    async getQuote(symbol) {
      const price = quotePrices.get(symbol);
      if (!price) throw new Error(`No real quote for ${symbol}`);
      return { symbol, status: "real", source: "stub-real", price, previousClose: price, at: now };
    },
    async getBars(symbol, range) {
      return { symbol, range, interval: "1day", source: "stub-real", bars: marketBars.slice(0, visibleBarCount) };
    }
  };
  const enginePool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  const ledger = createLedger({ client, repositories, clock: () => now, idFactory });
  const broker = createPaperBroker({
    ledger,
    market,
    clock: () => now,
    idFactory,
    quoteFreshnessMs: 5_000,
    fillModel: { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 }
  });
  const supervisorRepositories = researchOverrides
    ? Object.freeze({
        ...repositories,
        research: Object.freeze({ ...repositories.research, ...researchOverrides })
      })
    : repositories;
  const supervisor = createSupervisor({
    client,
    repositories: supervisorRepositories,
    market,
    enginePool,
    ledger,
    broker,
    scheduler,
    eventHub: { publish(type, payload) { events.push({ type, payload }); } },
    alertEvaluator: async (event, sessionId) => { alerts.push({ event, sessionId }); },
    clock: () => now,
    idFactory
  });
  await repositories.algorithms.create({
    id: "fixture-algorithm",
    name: "Supervisor fixture",
    sourcePath: "fixture.js",
    createdAt: now
  });
  await repositories.algorithms.addVersion({
    id: "fixture-version",
    algorithmId: "fixture-algorithm",
    sourceHash: "fixture-source-hash",
    sourceCode: ALGORITHM_SOURCE,
    params: { entry: 1, exit: 3 },
    createdAt: now
  });
  t.after(async () => {
    await supervisor.close();
    await enginePool.close();
    await client.close();
  });
  return {
    client,
    repositories,
    scheduler,
    events,
    alerts,
    ledger,
    broker,
    supervisor,
    quotePrices,
    setNow(value) { now = value; },
    setVisibleBars(value) { visibleBarCount = value; },
    appendNextBar() {
      const prior = marketBars.at(-1);
      const open = prior.close;
      marketBars.push({
        time: prior.time + 86_400_000,
        open,
        high: open + 2,
        low: open - 2,
        close: open + 1,
        volume: prior.volume + 1_000
      });
      return marketBars.at(-1);
    },
    advance(ms) { now += ms; }
  };
}

function sessionInput(id, overrides = {}) {
  return {
    id,
    name: `Session ${id}`,
    mode: "backtest",
    algorithmVersionId: "fixture-version",
    params: { entry: 1, exit: 3 },
    symbols: ["AAPL"],
    barInterval: "1day",
    fillModel: { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 },
    riskProfile: { rules: { maxDrawdown: { percentFromPeak: 10 } } },
    ...overrides
  };
}

function researchPlan({ id = "strategy-research", required = true, symbols = ["AAPL"] } = {}) {
  return {
    schemaVersion: 1,
    id,
    name: "Strategy research fixture",
    symbols,
    steps: [
      {
        id: "page",
        kind: "scrape",
        adapter: "web.page.v1",
        request: {
          sourceId: "fixture-source",
          pathTemplate: "/markets/{symbol}",
          format: "html"
        },
        limits: { timeoutMs: 1_000, maxBytes: 10_000 }
      },
      {
        id: "summary",
        kind: "summarize",
        adapter: "ai.cli.summary.v1",
        dependsOn: ["page"],
        promptTemplate: "market-summary.v1",
        responseSchema: "market-summary.v1",
        limits: { timeoutMs: 1_000, maxInputBytes: 10_000 }
      }
    ],
    outputStep: "summary",
    delivery: { strategy: true, required, maxAgeMs: 0 }
  };
}

async function importResearchPlan(context, {
  plan = researchPlan(),
  versionId = `${plan.id}-v1`,
  sourceHash = "1".repeat(64),
  at = START
} = {}) {
  return context.repositories.research.importPlan({
    planId: plan.id,
    name: plan.name,
    description: plan.description ?? null,
    sourceHash,
    manifest: plan,
    versionId,
    at
  });
}

function researchSnapshot({
  id = "strategy-snapshot",
  runId = `run-${id}`,
  planId = "strategy-research",
  planVersionId = `${planId}-v1`,
  symbol = "AAPL",
  availableAt
}) {
  return ResearchSnapshotSchema.parse({
    id,
    runId,
    planId,
    planVersionId,
    schemaVersion: 1,
    symbol,
    asOf: availableAt,
    availableAt,
    expiresAt: null,
    summary: {
      overview: "Validated strategy research fixture.",
      keyDrivers: ["Demand"],
      risks: ["Competition"],
      opportunities: ["Expansion"],
      sentiment: "bullish",
      confidence: 0.9
    },
    sources: [{
      stepId: "page",
      sourceId: "fixture-source",
      url: "https://example.com/markets/aapl",
      title: null,
      fetchedAt: availableAt,
      publishedAt: null,
      contentType: "text/html",
      contentHash: "a".repeat(64)
    }],
    sourceBundleHash: "b".repeat(64),
    aiInputHash: "e".repeat(64),
    summarizerConfigHash: "f".repeat(64),
    inputDocuments: [{
      stepId: "page",
      sourceId: "fixture-source",
      contentHash: "a".repeat(64),
      sourceBytes: 100,
      includedBytes: 100,
      truncated: false
    }],
    promptHash: "c".repeat(64),
    model: "fixture-model",
    contentHash: "d".repeat(64)
  });
}

async function persistResearchSnapshot(context, snapshot) {
  await context.repositories.research.createRun({
    id: snapshot.runId,
    planVersionId: snapshot.planVersionId,
    symbol: snapshot.symbol,
    request: {},
    createdAt: snapshot.availableAt
  });
  await context.repositories.research.startRun(snapshot.runId, { at: snapshot.availableAt });
  return context.repositories.research.publishSnapshot({
    runId: snapshot.runId,
    completedAt: snapshot.availableAt,
    result: { snapshotId: snapshot.id },
    snapshot: {
      id: snapshot.id,
      runId: snapshot.runId,
      planVersionId: snapshot.planVersionId,
      symbol: snapshot.symbol,
      availableAt: snapshot.availableAt,
      summaryText: snapshot.summary.overview,
      snapshot,
      sourceHash: snapshot.sourceBundleHash,
      provenance: { sources: snapshot.sources },
      createdAt: snapshot.availableAt
    }
  });
}

test("backtests persist durable results and expose route-facing query APIs", async (t) => {
  const context = await harness(t);
  const boot = await context.supervisor.bootstrap();
  assert.equal(boot.account.id, DEFAULT_ACCOUNT_ID);

  const created = await context.supervisor.create(sessionInput("backtest-1"));
  assert.deepEqual(created.scheduleJson, { type: "manual", timezone: "UTC" });
  const completed = await context.supervisor.start(created.id);
  assert.equal(completed.status, "stopped");

  const detail = await context.supervisor.get(created.id);
  assert.equal(detail.session.id, created.id);
  assert.equal(detail.metrics.tradeCount, 2);
  assert.ok(detail.metrics.finalEquity > 0);
  const listed = await context.supervisor.list({ mode: "backtest" });
  assert.equal(listed.find((session) => session.id === created.id).metrics.tradeCount, 2);

  const fullEquity = await context.supervisor.getEquity(created.id);
  const sampled = await context.supervisor.getEquity(created.id, { resolution: 8 });
  assert.equal(sampled.length, 8);
  assert.deepEqual(sampled[0], fullEquity[0]);
  assert.deepEqual(sampled.at(-1), fullEquity.at(-1));
  await assert.rejects(() => context.supervisor.getEquity(created.id, { resolution: 2.5 }), /integer/);

  const orders = await context.supervisor.getOrders(created.id);
  assert.equal(orders.length, 2);
  assert.ok(orders.every((order) => order.status === "filled" && order.fills.length === 1));
  const events = await context.supervisor.getEvents(created.id);
  assert.ok(events.some((event) => event.action === "session_created"));
  assert.ok(events.some((event) => event.type === "state_transition"));
  const exported = await context.supervisor.exportData(created.id);
  assert.equal(exported.session.id, created.id);
  assert.equal(exported.orders.length, 2);
  assert.equal(exported.equity.length, fullEquity.length);

  const second = await context.supervisor.create(sessionInput("backtest-2", {
    params: { entry: 2, exit: 5 },
    fillModel: { slippageBps: 15, fixedCommission: 1, perShareCommission: 0.01 },
    riskProfile: { rules: { maxDrawdown: { percentFromPeak: 5 } } }
  }));
  await context.supervisor.start(second.id);
  const comparison = await context.supervisor.compare([created.id, second.id]);
  assert.equal(comparison.sessions.length, 2);
  assert.equal(comparison.curves.length, 2);
  assert.ok(comparison.curves.every((curve) => curve.points[0].equity === 100));
  assert.equal(Object.keys(comparison.metricMatrix.tradeCount).length, 2);
  assert.ok(comparison.configDiff.paramsJson);
  assert.ok(comparison.configDiff.fillModelJson);
  assert.ok(comparison.configDiff.riskProfileJson);
});

test("session research pins resolve once and backtests persist point-in-time provenance", async (t) => {
  const context = await harness(t);
  await context.supervisor.bootstrap();
  const plan = researchPlan();
  await importResearchPlan(context, { plan, versionId: "strategy-research-v1" });
  const imported = await importResearchPlan(context, {
    plan,
    versionId: "strategy-research-v2",
    sourceHash: "2".repeat(64),
    at: START + 1
  });
  const snapshot = researchSnapshot({
    planVersionId: imported.version.id,
    availableAt: deterministicBars[1].time
  });
  const priorSnapshot = researchSnapshot({
    id: "strategy-snapshot-prior",
    planVersionId: imported.version.id,
    availableAt: deterministicBars[0].time - 1
  });
  const futureSnapshot = researchSnapshot({
    id: "strategy-snapshot-future",
    planVersionId: imported.version.id,
    availableAt: deterministicBars.at(-1).time + 1
  });
  await persistResearchSnapshot(context, priorSnapshot);
  await persistResearchSnapshot(context, snapshot);
  await persistResearchSnapshot(context, futureSnapshot);
  const storedTimeline = await context.repositories.research.timeline({
    planVersionId: imported.version.id,
    symbol: "AAPL",
    afterAvailableAt: deterministicBars[0].time,
    beforeAvailableAt: deterministicBars.at(-1).time,
    limit: 5_000
  });
  assert.equal(storedTimeline.length, 1);

  const created = await context.supervisor.create(sessionInput("research-backtest", {
    researchPlanId: imported.plan.id
  }));
  assert.equal(created.researchPlanVersionId, imported.version.id);
  await importResearchPlan(context, {
    plan,
    versionId: "strategy-research-v3",
    sourceHash: "3".repeat(64),
    at: START + 2
  });
  const completed = await context.supervisor.start(created.id);
  assert.equal(completed.status, "stopped");

  const orders = await context.repositories.orders.list({ sessionId: created.id });
  const exported = await context.supervisor.exportData(created.id);
  assert.equal(orders.length, 2, JSON.stringify(exported.backtestConfig));
  assert.ok(orders.every((order) => order.researchSnapshotId === snapshot.id));
  assert.equal(exported.session.researchPlanVersionId, imported.version.id);
  assert.equal(exported.backtestConfig.researchPlanVersionId, imported.version.id);
  assert.equal(
    exported.backtestConfig.symbols.AAPL.researchTimelineHash,
    researchTimelineHash([priorSnapshot, snapshot])
  );

  await assert.rejects(
    () => context.supervisor.create(sessionInput("ambiguous-research", {
      researchPlanId: imported.plan.id,
      researchPlanVersionId: imported.version.id
    })),
    (error) => error.code === "RESEARCH_PIN_AMBIGUOUS"
  );
});

test("backtests reject a truncated archived research timeline", async (t) => {
  const context = await harness(t, {
    researchOverrides: { countTimeline: async () => 5_001 }
  });
  await context.supervisor.bootstrap();
  const imported = await importResearchPlan(context);
  const session = await context.supervisor.create(sessionInput("research-timeline-overflow", {
    researchPlanVersionId: imported.version.id
  }));

  await assert.rejects(
    () => context.supervisor.start(session.id),
    (error) => {
      assert.equal(error.code, "RESEARCH_TIMELINE_TOO_LARGE");
      assert.equal(error.status, 422);
      assert.deepEqual(
        { count: error.detail.count, limit: error.detail.limit, symbol: error.detail.symbol },
        { count: 5_001, limit: 5_000, symbol: "AAPL" }
      );
      return true;
    }
  );
});

test("required paper research skips unavailable bars and pins the selected snapshot on orders", async (t) => {
  const context = await harness(t);
  const signalIndex = 39;
  const signalAt = Date.UTC(2025, 1, 10, 21, 0, 2);
  context.setVisibleBars(signalIndex + 1);
  context.setNow(signalAt);
  await context.supervisor.bootstrap();
  const imported = await importResearchPlan(context);

  const unavailable = await context.supervisor.create(sessionInput("required-research-missing", {
    mode: "paper",
    params: { entry: signalIndex, exit: signalIndex + 2 },
    researchPlanVersionId: imported.version.id
  }));
  await context.supervisor.start(unavailable.id);
  const skipped = await context.supervisor.tick(unavailable.id, {
    kind: "market",
    phase: "close",
    interval: "1day",
    scheduledAt: signalAt
  });
  assert.equal(skipped.signals.length, 0);
  assert.equal(
    (await context.repositories.orders.list({ sessionId: unavailable.id, status: "pending" })).length,
    0
  );
  assert.ok((await context.supervisor.getEvents(unavailable.id)).some(
    (event) => event.action === "session_research_unavailable"
  ));

  const snapshot = researchSnapshot({ availableAt: deterministicBars[signalIndex].time });
  await persistResearchSnapshot(context, snapshot);
  assert.ok(await context.repositories.research.latestEligibleSnapshot({
    planVersionId: imported.version.id,
    symbol: "AAPL",
    availableAt: deterministicBars[signalIndex].time
  }));
  const available = await context.supervisor.create(sessionInput("required-research-available", {
    mode: "paper",
    params: { entry: signalIndex, exit: signalIndex + 2 },
    researchPlanVersionId: imported.version.id
  }));
  await context.supervisor.start(available.id);
  const evaluated = await context.supervisor.tick(available.id, {
    kind: "market",
    phase: "close",
    interval: "1day",
    scheduledAt: signalAt
  });
  assert.equal(
    evaluated.signals.length,
    1,
    JSON.stringify(await context.supervisor.getEvents(available.id))
  );
  assert.equal(evaluated.signals[0].research.snapshot.id, snapshot.id);
  assert.equal(evaluated.signals[0].order.researchSnapshotId, snapshot.id);
  const persisted = await context.repositories.orders.getById(evaluated.signals[0].order.id);
  assert.equal(persisted.researchSnapshotId, snapshot.id);

  const nextOpenAt = Date.UTC(2025, 1, 11, 14, 30, 2);
  context.setVisibleBars(signalIndex + 2);
  context.setNow(nextOpenAt);
  const filled = await context.supervisor.tick(available.id, {
    kind: "market",
    phase: "open",
    interval: "1day",
    scheduledAt: nextOpenAt
  });
  assert.equal(filled.fills.length, 1);
  assert.equal(filled.fills[0].order.researchSnapshotId, snapshot.id);
});

test("a paper signal is pending on tick N and fills only on tick N+1", async (t) => {
  const context = await harness(t);
  const signalIndex = 39;
  const signalAt = Date.UTC(2025, 1, 10, 21, 0, 2);
  const nextOpenAt = Date.UTC(2025, 1, 11, 14, 30, 2);
  context.setVisibleBars(signalIndex + 1);
  context.setNow(signalAt);
  await context.supervisor.bootstrap();
  const session = await context.supervisor.create(sessionInput("paper-signal", {
    mode: "paper",
    params: { entry: signalIndex, exit: signalIndex + 2 }
  }));
  assert.equal((await context.supervisor.start(session.id)).status, "running");
  assert.equal(context.scheduler.has(session.id), true);

  const firstTick = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "close",
    interval: "1day",
    scheduledAt: signalAt
  });
  assert.equal(firstTick.signals.length, 1);
  assert.equal(firstTick.signals[0].order.status, "pending");
  assert.equal(firstTick.fills.length, 0);
  assert.equal((await context.repositories.orders.list({ sessionId: session.id, status: "pending" })).length, 1);
  assert.equal((await context.ledger.listOpenPositions(DEFAULT_ACCOUNT_ID)).length, 0);

  const nextBar = deterministicBars[signalIndex + 1];
  context.setVisibleBars(signalIndex + 2);
  context.setNow(nextOpenAt);
  const secondTick = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "open",
    interval: "1day",
    scheduledAt: nextOpenAt
  });
  assert.equal(secondTick.fills.length, 1);
  assert.equal(secondTick.fills[0].order.status, "filled");
  assert.equal((await context.repositories.orders.list({ sessionId: session.id, status: "pending" })).length, 0);
  assert.equal((await context.ledger.listOpenPositions(DEFAULT_ACCOUNT_ID)).length, 1);
  assert.equal((await context.repositories.orders.listFills({ sessionId: session.id })).length, 1);
  assert.equal(secondTick.fills[0].fills[0].referencePrice, Math.round(nextBar.open * 100));
  assert.ok(context.alerts.some(({ event }) => event.type === "signal"));
  assert.ok(context.alerts.some(({ event }) => event.type === "fill"));

  assert.equal((await context.supervisor.pause(session.id)).status, "paused");
  assert.equal(context.scheduler.has(session.id), true, "paused sessions keep risk-monitor ticks armed");
  const pausedTick = await context.supervisor.tick(session.id);
  assert.equal(pausedTick.signals.length, 0);
  assert.equal((await context.supervisor.resume(session.id)).status, "running");
  assert.equal(context.scheduler.has(session.id), true);
  const firstHalt = await context.supervisor.halt(session.id, { reason: "operator" });
  const secondHalt = await context.supervisor.halt(session.id, { reason: "operator" });
  assert.equal(firstHalt.session.status, "halted");
  assert.equal(secondHalt.idempotent, true);
  assert.ok((await context.supervisor.get(session.id)).metrics);
  const riskEvents = await context.repositories.risk.listEvents({ sessionId: session.id });
  assert.equal(riskEvents.filter((event) => event.ruleId === "manual_halt").length, 1);
});

test("continuous risk halts before a pending buy can fill", async (t) => {
  const context = await harness(t);
  const signalIndex = 39;
  const signalAt = Date.UTC(2025, 1, 10, 21, 0, 2);
  const nextOpenAt = Date.UTC(2025, 1, 11, 14, 30, 2);
  context.setVisibleBars(signalIndex + 2);
  context.setNow(signalAt);
  await context.supervisor.bootstrap();
  const session = await context.supervisor.create(sessionInput("risk-before-fill", {
    mode: "paper",
    params: { entry: 999, exit: 1_000 },
    riskProfile: { rules: { maxDailyLoss: { percentOfStartingEquity: 3 } } }
  }));
  await context.supervisor.start(session.id);
  await context.broker.submitOrder({
    accountId: DEFAULT_ACCOUNT_ID,
    sessionId: session.id,
    clientOrderId: "risk-before-fill-position",
    symbol: "AAPL",
    side: "buy",
    qty: 500_000_000
  });
  await context.repositories.sessions.addEquitySnapshot({
    sessionId: session.id,
    at: signalAt,
    equity: 10_000_000,
    cash: 5_000_000,
    positionValue: 5_000_000
  });
  await context.broker.queueOrder({
    accountId: DEFAULT_ACCOUNT_ID,
    sessionId: session.id,
    clientOrderId: "risk-before-fill-pending",
    symbol: "MSFT",
    side: "buy",
    qty: 1_000_000,
    signalBarAt: deterministicBars[signalIndex].time,
    submittedAt: signalAt
  });

  context.quotePrices.set("AAPL", 80);
  context.setNow(nextOpenAt);
  const tick = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "open",
    interval: "1day",
    scheduledAt: nextOpenAt
  });
  assert.equal(tick.session.status, "halted");
  const pending = await context.repositories.orders.getByClientOrderId("risk-before-fill-pending");
  assert.equal(pending.status, "pending");
  assert.equal((await context.repositories.orders.listFills({ orderId: pending.id })).length, 0);
});

test("unavailable position marks pause before a pending buy is processed", async (t) => {
  const context = await harness(t);
  const signalIndex = 39;
  const signalAt = Date.UTC(2025, 1, 10, 21, 0, 2);
  const nextOpenAt = Date.UTC(2025, 1, 11, 14, 30, 2);
  context.setVisibleBars(signalIndex + 2);
  context.setNow(signalAt);
  await context.supervisor.bootstrap();
  const session = await context.supervisor.create(sessionInput("pause-before-fill", {
    mode: "paper",
    params: { entry: 999, exit: 1_000 }
  }));
  await context.supervisor.start(session.id);
  await context.broker.submitOrder({
    accountId: DEFAULT_ACCOUNT_ID,
    sessionId: session.id,
    clientOrderId: "pause-before-fill-position",
    symbol: "AAPL",
    side: "buy",
    qty: 1_000_000
  });
  await context.broker.queueOrder({
    accountId: DEFAULT_ACCOUNT_ID,
    sessionId: session.id,
    clientOrderId: "pause-before-fill-pending",
    symbol: "MSFT",
    side: "buy",
    qty: 1_000_000,
    signalBarAt: deterministicBars[signalIndex].time,
    submittedAt: signalAt
  });

  context.quotePrices.delete("AAPL");
  context.setNow(nextOpenAt);
  const tick = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "open",
    interval: "1day",
    scheduledAt: nextOpenAt
  });
  assert.equal(tick.session.status, "paused");
  assert.equal(tick.fills.length, 0);
  const pending = await context.repositories.orders.getByClientOrderId("pause-before-fill-pending");
  assert.equal(pending.status, "pending");
});

test("a protective stop-loss is attributed once while its exit remains pending", async (t) => {
  const context = await harness(t);
  context.setNow(Date.UTC(2025, 2, 3, 15, 0, 2));
  await context.supervisor.bootstrap();
  const session = await context.supervisor.create(sessionInput("single-stop-loss", {
    mode: "paper",
    params: { entry: 999, exit: 1_000 }
  }));
  await context.supervisor.start(session.id);
  await context.broker.submitOrder({
    accountId: DEFAULT_ACCOUNT_ID,
    sessionId: session.id,
    clientOrderId: "single-stop-loss-position",
    symbol: "AAPL",
    side: "buy",
    qty: 1_000_000
  });
  context.quotePrices.set("AAPL", 90);

  const first = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "close",
    interval: "1day",
    scheduledAt: Date.UTC(2025, 2, 3, 15, 0, 2)
  });
  const second = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "close",
    interval: "1day",
    scheduledAt: Date.UTC(2025, 2, 3, 15, 0, 2)
  });
  assert.equal(first.protectiveExits.length, 1);
  assert.equal(second.protectiveExits.length, 1);
  const pendingExits = await context.repositories.orders.list({
    sessionId: session.id,
    status: "pending"
  });
  assert.equal(pendingExits.filter((order) => order.side === "sell").length, 1);
  const riskEvents = await context.repositories.risk.listEvents({ sessionId: session.id });
  assert.equal(riskEvents.filter((event) => event.ruleId === "position_stop_loss").length, 1);
  const events = await context.supervisor.getEvents(session.id);
  assert.equal(events.filter((event) => event.action === "session_protective_exit").length, 1);
});

test("a missed exact successor is rejected instead of filling at a later bar", async (t) => {
  const context = await harness(t);
  const signalIndex = 39;
  const signalAt = Date.UTC(2025, 1, 10, 21, 0, 2);
  const laterOpenAt = Date.UTC(2025, 1, 12, 14, 30, 2);
  context.setVisibleBars(signalIndex + 3);
  context.setNow(signalAt);
  await context.supervisor.bootstrap();
  const session = await context.supervisor.create(sessionInput("missed-successor", {
    mode: "paper",
    params: { entry: 999, exit: 1_000 }
  }));
  await context.supervisor.start(session.id);
  await context.broker.queueOrder({
    accountId: DEFAULT_ACCOUNT_ID,
    sessionId: session.id,
    clientOrderId: "missed-successor-order",
    symbol: "AAPL",
    side: "buy",
    qty: 1_000_000,
    signalBarAt: deterministicBars[signalIndex].time,
    submittedAt: signalAt
  });

  context.setNow(laterOpenAt);
  const tick = await context.supervisor.tick(session.id, {
    kind: "market",
    phase: "open",
    interval: "1day",
    scheduledAt: laterOpenAt
  });
  assert.equal(tick.fills.length, 1);
  assert.equal(tick.fills[0].order.status, "rejected");
  assert.equal(tick.fills[0].order.rejectReason, "missed_next_bar_open");
  assert.equal((await context.repositories.orders.listFills({ orderId: tick.fills[0].order.id })).length, 0);
});

test("halt-all covers active sessions and restart recovery defaults them to errored", async (t) => {
  const context = await harness(t);
  await context.supervisor.bootstrap();
  const first = await context.supervisor.create(sessionInput("paper-a", { mode: "paper" }));
  const second = await context.supervisor.create(sessionInput("paper-b", { mode: "paper", symbols: ["MSFT"] }));
  await context.supervisor.start(first.id);
  await context.supervisor.start(second.id);
  const halted = await context.supervisor.haltAll(DEFAULT_ACCOUNT_ID);
  assert.deepEqual(new Set(halted.halted.map((item) => item.session.id)), new Set([first.id, second.id]));
  assert.equal((await context.supervisor.get(first.id)).session.status, "halted");
  assert.equal((await context.supervisor.get(second.id)).session.status, "halted");

  await context.repositories.sessions.create({
    id: "orphaned-running",
    accountId: DEFAULT_ACCOUNT_ID,
    name: "Orphaned running",
    mode: "paper",
    status: "running",
    algorithmVersionId: "fixture-version",
    params: {},
    symbols: ["AAPL"],
    barInterval: "1day",
    fillModel: {},
    riskProfile: {},
    schedule: { type: "manual", timezone: "UTC" },
    startingEquity: 10_000_000,
    createdAt: START
  });
  const restart = await context.supervisor.bootstrap();
  assert.ok(restart.recovered.some((session) => session.id === "orphaned-running"));
  const recovered = await context.repositories.sessions.getById("orphaned-running");
  assert.equal(recovered.status, "errored");
  assert.match(recovered.errorDetail, /server restarted/);
  const recoveryEvents = await context.supervisor.getEvents("orphaned-running");
  assert.ok(recoveryEvents.some((event) => event.action === "session_restart_error"));

  await assert.rejects(
    () => context.supervisor.create(sessionInput("invalid-schedule", { schedule: { type: "cron", expression: "bad" } })),
    (error) => error.code === "INVALID_SCHEDULE"
  );
});

test("fixed-window schedules stop durably and finalize paper metrics", async (t) => {
  const context = await harness(t);
  await context.supervisor.bootstrap();
  const session = await context.supervisor.create(sessionInput("scheduled-paper", {
    mode: "paper",
    params: { entry: 999, exit: 1_000 },
    schedule: { type: "fixed_window", timezone: "UTC", startAt: START - 1_000, endAt: START + 1_000 }
  }));
  await context.supervisor.start(session.id);
  context.advance(2_000);
  const tick = await context.supervisor.tick(session.id);
  assert.equal(tick.session.status, "stopped");
  assert.equal(tick.session.stopReason, "schedule");
  const detail = await context.supervisor.get(session.id);
  assert.equal(detail.metrics.tradeCount, 0);
  assert.equal(detail.metrics.winRate, null);
  assert.equal(detail.metrics.profitFactor, null);
});
