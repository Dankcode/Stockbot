import assert from "node:assert/strict";
import test from "node:test";

import { createSwarmScheduler } from "../../server/swarm/scheduler.js";
import { PLAN, bootStockbot, fixtureMarket } from "./fixture.js";

async function count(client, table, where = "", params = []) {
  return Number((await client.query(`SELECT COUNT(*) AS n FROM ${table} ${where}`, params))[0].n);
}

test("one research cycle: scheduled task → claim → Stockbot retrieval → SQL report → attributed HOLD → completed", async (t) => {
  const market = fixtureMarket({ provider: "alpaca" });
  const hub = await bootStockbot(t, { market });
  const { client } = hub.runtime;
  const a = await hub.provisionAgent("alpha");

  // The scheduler turns the plan cadence into exactly one task per slot, even across two supervisors.
  const tick = await hub.operator("POST", "/swarm/tick");
  assert.deepEqual(tick.data, { leader: true, created: 1, expired: 0, reconciled: 0 });
  assert.equal((await hub.operator("POST", "/swarm/tick")).data.created, 0);
  assert.equal(await hub.runtime.repositories.swarm.getLease("swarm-supervisor"), null, "a manual tick on a non-supervisor gives the lease back");
  // A running supervisor holds the lease; a second one is refused.
  assert.equal((await hub.runtime.scheduler.tick()).leader, true);
  const rival = createSwarmScheduler({ repositories: hub.runtime.repositories, holder: "supervisor:rival" });
  assert.equal((await rival.tick()).leader, false, "a second supervisor must not schedule while the lease is held");
  const [task] = (await a.api("GET", "/agent/tasks?status=pending")).data;
  assert.equal(task.createdBy, "scheduler");

  const claimed = await a.api("POST", `/agent/tasks/${task.id}/claim`);
  assert.equal(claimed.status, 200);
  assert.deepEqual(claimed.data.plan.universe.symbols, ["SPY", "QQQ"]);
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/claim`)).status, 409, "a task is claimed once");

  // Retrieval is performed by Stockbot; the receipt records the provider Stockbot actually used.
  const quote = await a.api("POST", `/agent/tasks/${task.id}/retrievals`, { kind: "market.quote", symbol: "SPY" });
  const bars = await a.api("POST", `/agent/tasks/${task.id}/retrievals`, { kind: "market.bars", symbol: "SPY", range: "3M" });
  assert.equal(quote.status, 201);
  assert.equal(quote.data.provider, "alpaca");
  assert.equal(quote.data.synthetic, false);
  assert.equal(quote.data.content.price, 100);
  assert.equal(bars.data.content.count, 30);
  assert.deepEqual(market.calls.slice(-2), [["quote", "SPY"], ["bars", "SPY", "3M"]]);
  // Outside the plan: an undeclared source kind, or a symbol outside the universe.
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/retrievals`, { kind: "web.page", sourceId: "x", path: "/a" })).error.code, "RETRIEVAL_NOT_IN_PLAN");
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/retrievals`, { kind: "market.quote", symbol: "TSLA" })).error.code, "SYMBOL_NOT_IN_PLAN");

  // Evidence must be a receipt Stockbot wrote for this task; agents cannot assert provenance.
  const hold = (evidence) => ({ summary: "No edge today.", decisions: [{ symbol: "SPY", action: "hold", score: 4, rationale: "Flat tape; wait.", evidence }] });
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/report`, hold(["made-up-receipt"]))).error.code, "EVIDENCE_NOT_RECEIPTED");
  const claimedProvenance = await a.api("POST", `/agent/tasks/${task.id}/report`, { ...hold([quote.data.receiptId]), provenance: "real_provider" });
  assert.equal(claimedProvenance.status, 422);
  assert.equal(claimedProvenance.error.code, "REPORT_INVALID");
  const evidenceFlag = await a.api("POST", `/agent/tasks/${task.id}/report`, {
    summary: "x", decisions: [{ symbol: "SPY", action: "hold", rationale: "x", evidence: [quote.data.receiptId], provider: "real_provider" }]
  });
  assert.equal(evidenceFlag.status, 422);

  // Another agent's receipt is not evidence for this task either.
  const b = await hub.provisionAgent("bravo");
  const bTask = (await hub.operator("POST", `/swarm/agents/${b.agent.id}/tasks`, {})).data;
  await b.api("POST", `/agent/tasks/${bTask.id}/claim`);
  const foreign = await b.api("POST", `/agent/tasks/${bTask.id}/retrievals`, { kind: "market.quote", symbol: "QQQ" });
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/report`, hold([foreign.data.receiptId]))).error.code, "EVIDENCE_NOT_RECEIPTED");
  assert.equal(await count(client, "agent_reports"), 0, "rejected reports leave no rows");

  const report = await a.api("POST", `/agent/tasks/${task.id}/report`, hold([quote.data.receiptId, bars.data.receiptId]));
  assert.equal(report.status, 201);
  assert.equal(report.data.task.status, "completed");
  assert.equal(report.data.task.reportId, report.data.report.id);
  assert.deepEqual(report.data.report.provenanceJson.providers, ["alpaca"]);
  assert.equal(report.data.report.provenanceJson.synthetic, false);
  assert.equal(report.data.report.provenanceJson.source, "stockbot_receipts");
  const [decision] = report.data.decisions;
  assert.equal(decision.action, "hold");
  assert.equal(decision.agentId, "agent-alpha");
  assert.equal(decision.taskId, task.id);
  assert.equal(decision.reportId, report.data.report.id);

  // The persisted chain, read back from SQL.
  const [row] = await client.query(
    `SELECT t.status, t.created_by, r.id AS report_id, d.action, d.symbol, a.name, COUNT(e.receipt_id) AS evidence
       FROM agent_tasks t
       JOIN agent_reports r ON r.task_id = t.id
       JOIN agent_decisions d ON d.report_id = r.id
       JOIN agents a ON a.id = d.agent_id
       JOIN report_evidence e ON e.report_id = r.id
      WHERE t.id = ?
      GROUP BY t.status, t.created_by, r.id, d.action, d.symbol, a.name`,
    [task.id]
  );
  assert.deepEqual({ ...row, evidence: Number(row.evidence) }, {
    status: "completed", created_by: "scheduler", report_id: report.data.report.id, action: "hold", symbol: "SPY", name: "alpha", evidence: 2
  });
  assert.equal(await count(client, "orders"), 0, "a HOLD cycle places no order");
  assert.equal(await count(client, "agent_intents"), 0);
  // A completed task accepts nothing more.
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/report`, hold([quote.data.receiptId]))).error.code, "TASK_NOT_CLAIMED");
  assert.equal((await a.api("POST", `/agent/tasks/${task.id}/retrievals`, { kind: "market.quote", symbol: "SPY" })).error.code, "TASK_NOT_CLAIMED");
});

test("synthetic data is labelled synthetic in receipts and report provenance", async (t) => {
  const hub = await bootStockbot(t, { market: fixtureMarket({ provider: "synthetic-live" }) });
  const a = await hub.provisionAgent("alpha");
  const task = (await hub.operator("POST", `/swarm/agents/${a.agent.id}/tasks`, {})).data;
  await a.api("POST", `/agent/tasks/${task.id}/claim`);
  const quote = await a.api("POST", `/agent/tasks/${task.id}/retrievals`, { kind: "market.quote", symbol: "QQQ" });
  assert.equal(quote.data.synthetic, true);
  const report = await a.api("POST", `/agent/tasks/${task.id}/report`, {
    summary: "s", decisions: [{ symbol: "QQQ", action: "hold", rationale: "r", evidence: [quote.data.receiptId] }]
  });
  assert.equal(report.data.report.provenanceJson.synthetic, true);
});

test("plans are validated, versioned and immutable; tasks expire visibly", async (t) => {
  let now = Date.UTC(2026, 9, 21, 14, 0);
  const hub = await bootStockbot(t);
  const a = await hub.provisionAgent("alpha");
  const swarm = hub.runtime.swarm;
  for (const bad of [
    { ...PLAN, decision: { ...PLAN.decision, positionPercent: 16 } },
    { ...PLAN, sources: ["shell.exec"] },
    { ...PLAN, code: "require('fs')" },
    { ...PLAN, universe: { symbols: ["$5"] } }
  ]) {
    assert.equal((await hub.operator("POST", `/swarm/agents/${a.agent.id}/plans`, { plan: bad })).status, 422);
  }
  const same = await hub.operator("POST", `/swarm/agents/${a.agent.id}/plans`, { plan: PLAN });
  assert.equal(same.status, 200, "an identical plan is not a new version");
  const v2 = await hub.operator("POST", `/swarm/agents/${a.agent.id}/plans`, { plan: { ...PLAN, name: "v2" } });
  assert.equal(v2.data.plan.version, 2);
  const versions = await hub.runtime.repositories.swarm.listPlans(a.agent.id);
  assert.deepEqual(versions.map((plan) => [plan.version, plan.status, plan.planJson.name]), [[1, "superseded", "Index ETF watch"], [2, "active", "v2"]]);

  const task = await swarm.createTask(a.agent.id, { dueAt: now, expiresInMinutes: 5 });
  assert.equal(task.status, "pending");
  assert.equal(await hub.runtime.repositories.swarm.expireTasks(now + 6 * 60_000), 1);
  const expired = await hub.runtime.repositories.swarm.getTask(task.id);
  assert.deepEqual([expired.status, expired.errorCode], ["expired", "not_claimed"]);
});

test("an agent cannot be created past the ceiling", async (t) => {
  const hub = await bootStockbot(t);
  for (let index = 0; index < 8; index += 1) await hub.operator("POST", "/swarm/agents", { name: `agent-${index}` });
  const ninth = await hub.operator("POST", "/swarm/agents", { name: "agent-9" });
  assert.equal(ninth.status, 409);
  assert.equal(ninth.error.code, "AGENT_CEILING");
});

test("slots missed while no supervisor ran are recorded as expired, never run late, and never predate the plan", async (t) => {
  const hub = await bootStockbot(t);
  const daily = { ...PLAN, cadence: [{ task: "research", schedule: { type: "daily", at: "16:15", timezone: "America/New_York", weekdays: [1, 2, 3, 4, 5] }, expiresAfterMinutes: 120 }] };
  const a = await hub.provisionAgent("alpha", daily);
  const repositories = hub.runtime.repositories;
  // Pretend the plan went live Monday 2026-10-19 09:00 ET, then the supervisor was down until Wednesday 23:00 ET.
  const plan = await repositories.swarm.getActivePlan(a.agent.id);
  await hub.runtime.client.execute("UPDATE agent_plans SET activated_at = ? WHERE id = ?", [Date.UTC(2026, 9, 19, 13, 0), plan.id]);
  const scheduler = createSwarmScheduler({ repositories, clock: () => Date.UTC(2026, 9, 22, 3, 0), holder: "supervisor:test" });
  const outcome = await scheduler.tick();
  assert.equal(outcome.created, 0, "nothing is due now");
  const tasks = await repositories.swarm.listTasks({ agentId: a.agent.id });
  assert.deepEqual(tasks.map((task) => [task.slot, task.status, task.errorCode]).sort(), [
    ["daily:0:2026-10-19", "expired", "supervisor_unavailable"],
    ["daily:0:2026-10-20", "expired", "supervisor_unavailable"],
    ["daily:0:2026-10-21", "expired", "supervisor_unavailable"]
  ]);
  await scheduler.tick();
  assert.equal((await repositories.swarm.listTasks({ agentId: a.agent.id })).length, 3, "recording a missed slot is idempotent");
  await scheduler.stop();
});
