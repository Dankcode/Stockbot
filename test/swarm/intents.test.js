import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createLedger } from "../../server/broker/ledger.js";
import { createPaperBroker } from "../../server/broker/paper-broker.js";
import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createIntentService, STRANDED_INTENT_MS } from "../../server/swarm/intents.js";
import { createSwarmService } from "../../server/swarm/service.js";
import { PLAN } from "./fixture.js";

const WEDNESDAY_15_ET = Date.UTC(2026, 9, 21, 19, 0); // regular session
const PLAN_SIZE_LIMIT = 8_000; // PLAN.decision.positionPercent = 8% of a $100k sleeve
const SATURDAY = Date.UTC(2026, 9, 24, 15, 0);
const FILL_MODEL = { slippageBps: 5, fixedCommission: 0, perShareCommission: 0, quantityPrecision: 6 };

async function harness(t, { quoteAt, wrapBroker } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-intents-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const state = { now: WEDNESDAY_15_ET, price: 100 };
  const clock = () => state.now;
  const market = {
    async getQuote(symbol) {
      return { symbol, price: state.price, status: "real", source: "alpaca", at: quoteAt ? quoteAt(state.now) : state.now };
    },
    async getBars() { throw new Error("not used"); }
  };
  const ledger = createLedger({ client, repositories, clock });
  await ledger.ensureDefaultAccount({ createdAt: state.now });
  const realBroker = createPaperBroker({ ledger, market, fillModel: FILL_MODEL, quoteFreshnessMs: 5_000, clock });
  const broker = wrapBroker ? wrapBroker(realBroker) : realBroker;
  const swarm = createSwarmService({ client, repositories, market, broker, clock });
  const intents = createIntentService({ client, repositories, market, broker, ledger, swarm, clock });

  const agent = await swarm.createAgent({ name: "alpha" });
  await swarm.savePlan(agent.id, PLAN);
  const task = await swarm.createTask(agent.id, { dueAt: state.now });
  await swarm.claimTask(agent, task.id);
  const receipt = await swarm.retrieve(agent, task.id, { kind: "market.quote", symbol: "SPY" });
  const { decisions } = await swarm.submitReport(agent, task.id, {
    summary: "Mixed.",
    decisions: [
      { symbol: "SPY", action: "buy", score: 8, rationale: "Breakout.", evidence: [receipt.receiptId] },
      { symbol: "QQQ", action: "hold", score: 5, rationale: "Wait.", evidence: [receipt.receiptId] }
    ]
  });
  const buy = decisions.find((decision) => decision.symbol === "SPY");
  const hold = decisions.find((decision) => decision.symbol === "QQQ");
  /** Another research cycle that records one decision, so tests can have several live buys. */
  const newDecision = async (symbol, action = "buy", score = 8) => {
    const extra = await swarm.createTask(agent.id, { dueAt: state.now });
    const fresh = await repositories.swarm.getAgent(agent.id);
    await swarm.claimTask(fresh, extra.id);
    const evidence = await swarm.retrieve(fresh, extra.id, { kind: "market.quote", symbol });
    const saved = await swarm.submitReport(fresh, extra.id, { summary: "More.", decisions: [{ symbol, action, score, rationale: "r", evidence: [evidence.receiptId] }] });
    return saved.decisions[0];
  };
  const enableOrders = async () => {
    await swarm.setGlobalIntents(true);
    await swarm.setAgentIntents(agent.id, true);
  };
  const orders = async () => client.query("SELECT * FROM orders ORDER BY submitted_at");
  const fresh = async () => repositories.swarm.getAgent(agent.id);
  return { client, repositories, swarm, intents, ledger, state, agent, fresh, buy, hold, enableOrders, orders, newDecision };
}

const buyIntent = (decision, extra = {}) => ({ idempotencyKey: "buy-spy-0001", decisionId: decision.id, symbol: "SPY", side: "buy", notional: 5_000, ...extra });

test("order intents are disabled until the operator enables them globally and for the agent", async (t) => {
  const h = await harness(t);
  const first = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  assert.deepEqual([first.intent.status, first.intent.rejectCode], ["rejected", "intents_disabled"]);
  await h.swarm.setGlobalIntents(true);
  const second = await h.intents.submit(await h.fresh(), buyIntent(h.buy, { idempotencyKey: "buy-spy-0002" }));
  assert.deepEqual([second.intent.status, second.intent.rejectCode], ["rejected", "intents_disabled"], "the global switch alone is not enough");
  await h.swarm.setGlobalIntents(false);
  await h.swarm.setAgentIntents(h.agent.id, true);
  const third = await h.intents.submit(await h.fresh(), buyIntent(h.buy, { idempotencyKey: "buy-spy-0003" }));
  assert.equal(third.intent.rejectCode, "intents_disabled", "the agent switch alone is not enough");
  assert.equal((await h.orders()).length, 0);
});

test("with orders enabled, a buy fills only in the agent's sleeve and is attributed", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  const outcome = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  assert.equal(outcome.intent.status, "filled");
  const [order] = await h.orders();
  assert.equal(order.account_id, "sleeve-alpha");
  assert.equal(order.client_order_id, outcome.intent.clientOrderId);
  assert.equal(order.signal_reason, `agent:alpha decision:${h.buy.id}`);
  assert.equal(outcome.intent.qty, 50_000_000);
  const sleeve = await h.repositories.accounts.getById("sleeve-alpha");
  const defaults = await h.repositories.accounts.getById("default-paper");
  assert.ok(sleeve.cash < 10_000_000);
  assert.equal(defaults.cash, 10_000_000, "the default account is untouched");
});

test("a HOLD decision cannot become an order, and limits are enforced", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  const fromHold = await h.intents.submit(await h.fresh(), buyIntent(h.hold, { symbol: "QQQ", idempotencyKey: "hold-to-buy-1" }));
  assert.equal(fromHold.intent.rejectCode, "decision_mismatch");
  const oversized = await h.intents.submit(await h.fresh(), buyIntent(h.buy, { notional: PLAN_SIZE_LIMIT + 1, idempotencyKey: "too-big-0001" }));
  assert.equal(oversized.intent.rejectCode, "max_position_ceiling", "the plan's 8% binds before the 15% ceiling");
  const sellNothing = await h.intents.submit(await h.fresh(), { idempotencyKey: "sell-none-01", decisionId: h.buy.id, symbol: "SPY", side: "sell" });
  assert.equal(sellNothing.intent.rejectCode, "decision_mismatch");
  await h.swarm.setAgentStatus(h.agent.id, "paused");
  const paused = await h.intents.submit(await h.fresh(), buyIntent(h.buy, { idempotencyKey: "paused-0001" }));
  assert.equal(paused.intent.rejectCode, "agent_not_active");
  assert.equal((await h.orders()).length, 0);
});

test("the market-hours guard holds: after the close a fresh quote is still refused", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  h.state.now = WEDNESDAY_15_ET + 2 * 60 * 60 * 1_000; // 17:00 ET, decision two hours old, quote fresh
  const outcome = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  assert.deepEqual([outcome.intent.status, outcome.intent.rejectCode], ["broker_rejected", "market_hours"]);
  assert.equal((await h.repositories.accounts.getById("sleeve-alpha")).cash, 10_000_000);
  h.state.now = SATURDAY;
  const weekend = await h.intents.submit(await h.fresh(), buyIntent(h.buy, { idempotencyKey: "weekend-0001" }));
  assert.equal(weekend.intent.rejectCode, "decision_stale", "a decision older than 24h is refused before any quote is used");
});

test("a quote stamped in the future is rejected, as is a stale one", async (t) => {
  const future = await harness(t, { quoteAt: (now) => now + 60_000 });
  await future.enableOrders();
  const ahead = await future.intents.submit(await future.fresh(), buyIntent(future.buy));
  assert.deepEqual([ahead.intent.status, ahead.intent.rejectCode], ["broker_rejected", "quote_future_dated"]);
  assert.equal((await future.orders())[0].status, "rejected");
  assert.equal((await future.repositories.accounts.getById("sleeve-alpha")).cash, 10_000_000);

  const stale = await harness(t, { quoteAt: (now) => now - 60_000 });
  await stale.enableOrders();
  const old = await stale.intents.submit(await stale.fresh(), buyIntent(stale.buy));
  assert.deepEqual([old.intent.status, old.intent.rejectCode], ["broker_rejected", "quote_freshness"]);

  const skew = await harness(t, { quoteAt: (now) => now + 500 });
  await skew.enableOrders();
  assert.equal((await skew.intents.submit(await skew.fresh(), buyIntent(skew.buy))).intent.status, "filled", "sub-second clock skew is tolerated");
});

test("idempotency: a replay returns the same intent; a reused key with a new body is refused", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  const first = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  const replay = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  assert.equal(replay.intent.id, first.intent.id);
  assert.equal(replay.idempotent, true);
  await assert.rejects(h.intents.submit(await h.fresh(), buyIntent(h.buy, { notional: 4_000 })), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.equal((await h.orders()).length, 1);
});

test("interrupted after the ledger wrote the order: the retry reconciles it instead of duplicating", async (t) => {
  let crash = true;
  const h = await harness(t, {
    wrapBroker: (broker) => ({
      ...broker,
      async submitOrder(input) {
        const execution = await broker.submitOrder(input);
        if (crash) { crash = false; throw new Error("process died before the acknowledgement"); }
        return execution;
      }
    })
  });
  await h.enableOrders();
  await assert.rejects(h.intents.submit(await h.fresh(), buyIntent(h.buy)), /process died/);
  const stranded = await h.repositories.swarm.getIntentByKey(h.agent.id, "buy-spy-0001");
  assert.equal(stranded.status, "submitting");
  assert.equal((await h.orders()).length, 1, "the order exists but the intent does not know it yet");

  const retry = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  assert.equal(retry.intent.status, "filled");
  assert.equal(retry.intent.orderId, (await h.orders())[0].id);
  assert.equal((await h.orders()).length, 1, "no duplicate order");
});

test("interrupted before the order was written: the retry sends it exactly once", async (t) => {
  let crash = true;
  const h = await harness(t, {
    wrapBroker: (broker) => ({
      ...broker,
      async submitOrder(input) {
        if (crash) { crash = false; throw new Error("connection reset before submission"); }
        return broker.submitOrder(input);
      }
    })
  });
  await h.enableOrders();
  await assert.rejects(h.intents.submit(await h.fresh(), buyIntent(h.buy)), /connection reset/);
  assert.equal((await h.orders()).length, 0);
  const retry = await h.intents.submit(await h.fresh(), buyIntent(h.buy));
  assert.equal(retry.intent.status, "filled");
  assert.equal(retry.intent.attempts, 2);
  assert.equal((await h.orders()).length, 1);
});

test("the background sweep never strands an intent and never resubmits a stale one", async (t) => {
  let mode = "after-write";
  const h = await harness(t, {
    wrapBroker: (broker) => ({
      ...broker,
      async submitOrder(input) {
        if (mode === "after-write") { mode = "before-write"; await broker.submitOrder(input); throw new Error("died"); }
        if (mode === "before-write") { mode = "ok"; throw new Error("died"); }
        return broker.submitOrder(input);
      }
    })
  });
  await h.enableOrders();
  await assert.rejects(h.intents.submit(await h.fresh(), buyIntent(h.buy)));
  const qqq = await h.newDecision("QQQ");
  await assert.rejects(h.intents.submit(await h.fresh(), buyIntent(qqq, { symbol: "QQQ", idempotencyKey: "buy-qqq-0002", notional: 1_000 })));
  assert.equal((await h.intents.reconcileStranded()).length, 0, "fresh intents are left to the agent's own retry");
  h.state.now += STRANDED_INTENT_MS + 1;
  const outcomes = await h.intents.reconcileStranded();
  assert.deepEqual(outcomes.map(({ intent }) => [intent.status, intent.rejectCode]).sort(), [["filled", null], ["rejected", "submission_interrupted"]]);
  assert.equal((await h.orders()).length, 1, "the unwritten one was closed out, not sent minutes late");
});

test("concurrent buys on one sleeve are serialized, so together they cannot pass the position cap", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  const second = await h.newDecision("SPY");
  const outcomes = await Promise.all([
    h.intents.submit(await h.fresh(), buyIntent(h.buy, { idempotencyKey: "race-0001", notional: 6_000 })),
    h.intents.submit(await h.fresh(), buyIntent(second, { idempotencyKey: "race-0002", notional: 6_000 }))
  ]);
  assert.deepEqual(outcomes.map(({ intent }) => intent.status).sort(), ["filled", "rejected"]);
  assert.equal(outcomes.find(({ intent }) => intent.status === "rejected").intent.rejectCode, "max_position_ceiling");
  assert.equal((await h.orders()).length, 1);
});

test("concurrent submits of the same key produce one order and one consistent intent", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  const [first, again] = await Promise.all([h.intents.submit(await h.fresh(), buyIntent(h.buy)), h.intents.submit(await h.fresh(), buyIntent(h.buy))]);
  assert.equal(first.intent.id, again.intent.id);
  assert.equal((await h.orders()).length, 1);
  const row = await h.repositories.swarm.getIntent(first.intent.id);
  assert.deepEqual([row.status, row.reject_code ?? row.rejectCode, row.attempts], ["filled", null, 1]);
});

test("the sweep never trades a 'received' intent late, and a terminal intent never moves back", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  // As if the process died right after recording the intent, before processing it.
  const intent = await h.repositories.swarm.insertIntent({
    id: "intent-orphan", agentId: h.agent.id, decisionId: h.buy.id, idempotencyKey: "orphan-0001", requestHash: "h",
    symbol: "SPY", side: "buy", notionalCents: 500_000, clientOrderId: "intent:intent-orphan", createdAt: h.state.now
  });
  assert.equal(intent.status, "received");
  assert.deepEqual(await h.intents.reconcileStranded(), [], "a fresh intent is left alone");
  h.state.now += STRANDED_INTENT_MS + 1;
  h.state.price = 104;
  const [outcome] = await h.intents.reconcileStranded();
  assert.deepEqual([outcome.intent.status, outcome.intent.rejectCode], ["rejected", "stale_received"]);
  assert.equal((await h.orders()).length, 0, "nothing was traded at the later price");
  assert.equal(await h.repositories.swarm.transitionIntent(intent.id, ["received", "submitting"], { status: "filled", at: h.state.now }), false,
    "a rejected intent cannot be moved to filled");
  const replay = await h.intents.submit(await h.fresh(), { idempotencyKey: "orphan-0001", decisionId: h.buy.id, symbol: "SPY", side: "buy", notional: 5_000 })
    .catch((error) => error);
  assert.equal(replay.code, "IDEMPOTENCY_KEY_REUSED", "the hand-made row's hash differs, so the key is refused rather than traded");
});

test("one decision backs at most one live intent; buys need the plan's minimum score", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  assert.equal((await h.intents.submit(await h.fresh(), buyIntent(h.buy, { notional: 1_000 }))).intent.status, "filled");
  const reuse = await h.intents.submit(await h.fresh(), buyIntent(h.buy, { idempotencyKey: "reuse-0001", notional: 1_000 }));
  assert.equal(reuse.intent.rejectCode, "decision_already_used");
  const weak = await h.newDecision("QQQ", "buy", 3);
  const lowScore = await h.intents.submit(await h.fresh(), buyIntent(weak, { symbol: "QQQ", idempotencyKey: "weak-0001", notional: 1_000 }));
  assert.equal(lowScore.intent.rejectCode, "score_below_plan");
});

test("sell edge cases: a sub-cent notional never sells the whole position, and a zero-quantity sell is a rejection", async (t) => {
  const h = await harness(t);
  await h.enableOrders();
  assert.equal((await h.intents.submit(await h.fresh(), buyIntent(h.buy, { notional: 5_000 }))).intent.status, "filled");
  const sell = await h.newDecision("SPY", "sell", 5);
  const tiny = await h.intents.submit(await h.fresh(), { idempotencyKey: "sell-tiny-01", decisionId: sell.id, symbol: "SPY", side: "sell", notional: 0.004 });
  assert.equal(tiny.intent.rejectCode, "notional_too_small");
  h.state.price = 1_000_000;
  const sell2 = await h.newDecision("SPY", "sell", 5);
  const micro = await h.intents.submit(await h.fresh(), { idempotencyKey: "sell-micro-1", decisionId: sell2.id, symbol: "SPY", side: "sell", notional: 0.01 });
  assert.deepEqual([micro.intent.status, micro.intent.rejectCode], ["rejected", "notional_too_small"]);
  const lots = await h.client.query("SELECT COUNT(*) AS n FROM position_lots WHERE account_id = 'sleeve-alpha' AND closed_at IS NULL");
  assert.equal(Number(lots[0].n), 1, "the position is still open");
});

test("paused or halted agents cannot research or report; retirement is final", async (t) => {
  const h = await harness(t);
  const task = await h.swarm.createTask(h.agent.id, { dueAt: h.state.now });
  await h.swarm.claimTask(await h.fresh(), task.id);
  await h.swarm.setAgentStatus(h.agent.id, "paused");
  await assert.rejects(h.swarm.retrieve(await h.fresh(), task.id, { kind: "market.quote", symbol: "SPY" }), { code: "AGENT_NOT_ACTIVE" });
  await h.swarm.setAgentStatus(h.agent.id, "halted");
  await assert.rejects(h.swarm.submitReport(await h.fresh(), task.id, { summary: "s", decisions: [{ symbol: "SPY", action: "hold", rationale: "r", evidence: ["x"] }] }), { code: "AGENT_NOT_ACTIVE" });
  await h.swarm.setAgentStatus(h.agent.id, "retired");
  await assert.rejects(h.swarm.setAgentStatus(h.agent.id, "active"), { code: "AGENT_RETIRED" });
  await assert.rejects(h.swarm.issueToken(h.agent.id), { code: "AGENT_RETIRED" });
});
