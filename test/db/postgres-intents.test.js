/**
 * Two Stockbot processes sharing one PostgreSQL database must not jointly break
 * a sleeve's position cap. Runs only with STOCKBOT_TEST_POSTGRES_URL (a disposable
 * server with CREATEDB); the scratch database is dropped afterwards.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createLedger } from "../../server/broker/ledger.js";
import { createPaperBroker } from "../../server/broker/paper-broker.js";
import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createIntentService } from "../../server/swarm/intents.js";
import { createSwarmService } from "../../server/swarm/service.js";
import { PLAN } from "../swarm/fixture.js";

const ADMIN_URL = process.env.STOCKBOT_TEST_POSTGRES_URL;
const NOW = Date.UTC(2026, 9, 21, 19, 0);

function process_(client) {
  // Everything a separate Stockbot process would build for itself, sharing only the database.
  const repositories = createRepositories(client);
  const clock = () => NOW;
  const market = { async getQuote(symbol) { return { symbol, price: 100, status: "real", source: "alpaca", at: NOW }; } };
  const ledger = createLedger({ client, repositories, clock });
  const broker = createPaperBroker({ ledger, market, fillModel: { slippageBps: 0 }, quoteFreshnessMs: 5_000, clock });
  const swarm = createSwarmService({ client, repositories, market, broker, clock });
  return { repositories, ledger, swarm, intents: createIntentService({ client, repositories, market, broker, ledger, swarm, clock }) };
}

test("PostgreSQL: concurrent buys from two processes cannot jointly exceed the position cap", { skip: !ADMIN_URL && "set STOCKBOT_TEST_POSTGRES_URL to a disposable server" }, async (t) => {
  const name = `stockbot_rehearsal_intents_${Date.now()}_${process.pid}`;
  const admin = await createClient(ADMIN_URL);
  await admin.exec(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL); url.pathname = `/${name}`;
  const clients = [await createClient(url.toString()), await createClient(url.toString())];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  });
  await migrate(clients[0]);
  const [one, two] = clients.map(process_);
  await one.ledger.ensureDefaultAccount({ createdAt: NOW });
  const agent = await one.swarm.createAgent({ name: "alpha" });
  await one.swarm.savePlan(agent.id, { ...PLAN, decision: { ...PLAN.decision, positionPercent: 15 } });
  const decisions = [];
  for (let index = 0; index < 2; index += 1) {
    const task = await one.swarm.createTask(agent.id, { dueAt: NOW });
    await one.swarm.claimTask(agent, task.id);
    const receipt = await one.swarm.retrieve(agent, task.id, { kind: "market.quote", symbol: "SPY" });
    decisions.push((await one.swarm.submitReport(agent, task.id, { summary: "s", decisions: [{ symbol: "SPY", action: "buy", score: 8, rationale: "r", evidence: [receipt.receiptId] }] })).decisions[0]);
  }
  await one.swarm.setGlobalIntents(true);
  await one.swarm.setAgentIntents(agent.id, true);
  const fresh = await one.repositories.swarm.getAgent(agent.id);
  const outcomes = await Promise.all([
    one.intents.submit(fresh, { idempotencyKey: "proc-one-0001", decisionId: decisions[0].id, symbol: "SPY", side: "buy", notional: 14_000 }),
    two.intents.submit(fresh, { idempotencyKey: "proc-two-0001", decisionId: decisions[1].id, symbol: "SPY", side: "buy", notional: 14_000 })
  ]);
  assert.deepEqual(outcomes.map(({ intent }) => [intent.status, intent.rejectCode]).sort(), [["filled", null], ["rejected", "max_position_ceiling"]]);
  assert.equal(Number((await clients[0].query("SELECT COUNT(*) AS n FROM orders WHERE status = 'filled'"))[0].n), 1);
});
