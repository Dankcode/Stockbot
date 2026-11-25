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
import { nyInstant } from "../../server/swarm/calendar.js";
import { createIntentService } from "../../server/swarm/intents.js";
import { createSwarmService } from "../../server/swarm/service.js";
import { PLAN } from "./fixture.js";

const MONDAY_1015_ET = nyInstant("2026-11-30", 10, 15);
const FILL_MODEL = { slippageBps: 5, fixedCommission: 0, perShareCommission: 0, quantityPrecision: 6 };
const DISCOVERY_PLAN = { ...PLAN, universe: { symbols: ["SPY"], discovery: { score: "growth", top: 9 } } };

/** Twelve candidates: D01 (score 99) ... D12 (score 88). D10..D12 fall outside SPY + 9. */
function scored(prefix, count, top) {
  return Array.from({ length: count }, (_, index) => {
    const symbol = `${prefix}${String(index + 1).padStart(2, "0")}`;
    return {
      symbol, name: symbol, exchange: "NASDAQ",
      metrics: { price: 100, mom6m: 0.3 - index / 100, vol1y: 0.4 },
      fundamentals: { revenueGrowthTTM: 30 - index, version: 2 },
      scores: { growth: { score: top - index }, hold: { score: 50 } }
    };
  });
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-universe-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const state = { now: MONDAY_1015_ET };
  const clock = () => state.now;
  const market = { async getQuote(symbol) { return { symbol, price: 100, status: "real", source: "alpaca", at: state.now }; } };
  const ledger = createLedger({ client, repositories, clock });
  await ledger.ensureDefaultAccount({ createdAt: state.now });
  const broker = createPaperBroker({ ledger, market, fillModel: FILL_MODEL, quoteFreshnessMs: 5_000, clock });
  const swarm = createSwarmService({ client, repositories, market, broker, ledger, clock });
  const intents = createIntentService({ client, repositories, market, broker, ledger, swarm, clock });
  const seedRun = async (id, completedAt, candidates) => {
    await repositories.discovery.createRun({ id, params: {}, createdAt: completedAt - 300_000 });
    await repositories.discovery.insertCandidates(id, candidates);
    await repositories.discovery.finishRun(id, { status: "completed", stats: {}, completedAt });
  };
  return { client, repositories, swarm, intents, broker, state, seedRun };
}

test("a task freezes SPY + the top 9 Discovery picks + holdings, and every check uses that list", async (t) => {
  const h = await harness(t);
  await h.seedRun("run-mon", MONDAY_1015_ET - 600_000, scored("D", 12, 99));
  const agent = await h.swarm.createAgent({ name: "growth" });
  await h.swarm.savePlan(agent.id, DISCOVERY_PLAN);
  // The sleeve already holds a stock that today's screen does not contain.
  await h.broker.submitOrder({ clientOrderId: "seed:OLDX", accountId: agent.accountId, symbol: "OLDX", side: "buy", qty: 10_000_000 });

  const task = await h.swarm.createTask(agent.id, { dueAt: h.state.now });
  const claimed = await h.swarm.claimTask(agent, task.id);
  const expected = ["SPY", "D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08", "D09", "OLDX"];
  assert.deepEqual(claimed.plan.universe.symbols, expected, "SPY + 9 picks (total 10) + the holding");
  assert.deepEqual(claimed.task.universeJson.symbols, expected);
  assert.deepEqual(claimed.plan.universe.entries[1], { symbol: "D01", source: "discovery", rank: 1, score: 99, lens: "growth" });
  assert.equal(claimed.plan.universe.discovery.runId, "run-mon");
  assert.equal(claimed.plan.universe.entries.at(-1).source, "holding");

  // In the list: allowed. Ranked 10th, outside the list: refused.
  assert.ok((await h.swarm.retrieve(agent, task.id, { kind: "market.quote", symbol: "D03" })).receiptId);
  await assert.rejects(h.swarm.retrieve(agent, task.id, { kind: "market.quote", symbol: "D10" }), { code: "SYMBOL_NOT_IN_PLAN" });

  // A newer run mid-cycle does not change the frozen list.
  await h.seedRun("run-later", MONDAY_1015_ET + 60_000, scored("N", 12, 100));
  assert.deepEqual((await h.swarm.currentTask(agent)).plan.universe.symbols, expected);

  const quote = (symbol) => h.swarm.retrieve(agent, task.id, { kind: "market.quote", symbol });
  const evidence = { D01: (await quote("D01")).receiptId, OLDX: (await quote("OLDX")).receiptId, SPY: (await quote("SPY")).receiptId };
  await assert.rejects(h.swarm.submitReport(agent, task.id, {
    summary: "x", decisions: [{ symbol: "D10", action: "buy", score: 9, rationale: "r", evidence: [evidence.D01] }]
  }), { code: "SYMBOL_NOT_IN_PLAN" });
  const { decisions } = await h.swarm.submitReport(agent, task.id, {
    summary: "Rotate.",
    decisions: [
      { symbol: "D01", action: "buy", score: 9, rationale: "Top growth pick, trend intact.", evidence: [evidence.D01] },
      { symbol: "SPY", action: "buy", score: 8, rationale: "Core.", evidence: [evidence.SPY] },
      { symbol: "OLDX", action: "sell", score: 3, rationale: "Left the screen.", evidence: [evidence.OLDX] }
    ]
  });
  const decision = (symbol) => decisions.find((entry) => entry.symbol === symbol);

  await h.swarm.setGlobalIntents(true);
  await h.swarm.setAgentIntents(agent.id, true);
  const fresh = await h.repositories.swarm.getAgent(agent.id);
  const bought = await h.intents.submit(fresh, { idempotencyKey: "buy-d01-0001", decisionId: decision("D01").id, symbol: "D01", side: "buy", notional: 5_000 });
  assert.equal(bought.intent.status, "filled");
  const stored = await h.repositories.swarm.getIntent(bought.intent.id);
  assert.equal(stored.entryFeaturesJson.source, "discovery");
  assert.equal(stored.entryFeaturesJson.rank, 1);
  assert.equal(stored.entryFeaturesJson.discoveryRunId, "run-mon");
  assert.equal(stored.entryFeaturesJson.decisionScore, 9);
  assert.equal(stored.entryFeaturesJson.features.revenueGrowthTTM, 30);
  assert.equal(stored.entryFeaturesJson.features.growthScore, 99);

  const spy = await h.intents.submit(fresh, { idempotencyKey: "buy-spy-0001", decisionId: decision("SPY").id, symbol: "SPY", side: "buy", notional: 5_000 });
  assert.equal(spy.intent.status, "filled", "SPY trades alongside the discovered stocks");
  const spyStored = await h.repositories.swarm.getIntent(spy.intent.id);
  assert.equal(spyStored.entryFeaturesJson.source, "pinned");
  assert.equal(spyStored.entryFeaturesJson.features, null, "no invented features for a pinned symbol");

  const sold = await h.intents.submit(fresh, { idempotencyKey: "sell-oldx-0001", decisionId: decision("OLDX").id, symbol: "OLDX", side: "sell" });
  assert.equal(sold.intent.status, "filled", "a holding outside the screen can always be exited");
  assert.equal((await h.repositories.swarm.getIntent(sold.intent.id)).entryFeaturesJson, null, "sells record no entry features");
});

test("with no fresh run the task falls back to SPY + holdings and records why", async (t) => {
  const h = await harness(t);
  await h.seedRun("run-old", nyInstant("2026-11-24", 10, 5), scored("D", 12, 99)); // Tuesday last week: stale on Monday
  const agent = await h.swarm.createAgent({ name: "hold" });
  await h.swarm.savePlan(agent.id, DISCOVERY_PLAN);
  const task = await h.swarm.createTask(agent.id, { dueAt: h.state.now });
  const claimed = await h.swarm.claimTask(agent, task.id);
  assert.deepEqual(claimed.plan.universe.symbols, ["SPY"]);
  assert.equal(claimed.plan.universe.discovery.fallback, "discovery_stale");
  const [entry] = await h.client.query("SELECT detail_json FROM audit_log WHERE action = 'agent_task_universe'");
  assert.match(entry.detail_json, /discovery_stale/);
});
