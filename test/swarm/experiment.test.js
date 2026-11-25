import assert from "node:assert/strict";
import test from "node:test";

import { AgentPlanSchema } from "../../packages/shared/swarm.js";
import { nyInstant } from "../../server/swarm/calendar.js";
import { experimentHarness } from "./experiment-fixture.js";

const MON = "2026-11-30";

test("an experiment creates a growth agent, a hold agent and a mechanical control, all starting the same day", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant("2026-11-27", 18, 0) }); // Friday after close
  const created = await h.experiments.createExperiment({ name: "disc" });
  assert.deepEqual(created.arms.map((arm) => [arm.label, arm.kind, arm.startDate]), [
    ["disc-growth", "agent", MON], ["disc-hold", "agent", MON], ["control-index", "control", MON]
  ], "starts the next trading day");
  const growthPlan = (await h.repositories.swarm.getActivePlan("agent-disc-growth")).planJson;
  assert.deepEqual(growthPlan.universe, { symbols: ["SPY"], discovery: { score: "growth", top: 9 }, totalCap: 10 });
  assert.equal((await h.repositories.swarm.getActivePlan("agent-disc-hold")).planJson.universe.discovery.score, "hold");
  assert.ok(AgentPlanSchema.safeParse(growthPlan).success);
  assert.deepEqual(growthPlan.cadence[0].schedule, { type: "daily", at: "10:15", timezone: "America/New_York", weekdays: [1, 2, 3, 4, 5] });
  const accounts = await Promise.all(created.arms.map((arm) => h.repositories.accounts.getById(arm.accountId)));
  assert.deepEqual(accounts.map((account) => Number(account.startingCash)), [10_000_000, 10_000_000, 10_000_000], "same cash for every arm");
  await assert.rejects(h.experiments.createExperiment({ name: "disc" }), { code: "EXPERIMENT_EXISTS" });
  await assert.rejects(h.experiments.createExperiment({ name: "x2", startDate: "2026-11-26" }), { code: "EXPERIMENT_INVALID" }, "Thanksgiving is not a trading day");
});

test("the control buys SPY and QQQ once at the start, then never trades again", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant("2026-11-27", 18, 0) });
  const { arms } = await h.experiments.createExperiment({ name: "disc" });
  const control = arms.find((arm) => arm.kind === "control");

  h.state.now = nyInstant("2026-11-28", 11, 0); // Saturday
  assert.equal(await h.jobs.tick(h.state.now), null);
  h.state.now = nyInstant(MON, 9, 45);
  const first = await h.jobs.tick(h.state.now);
  assert.deepEqual(first.find((entry) => entry.job === "control").legs.map((leg) => [leg.symbol, leg.status]), [["SPY", "filled"], ["QQQ", "filled"]]);
  const positions = await h.ledger.listOpenPositions(control.accountId);
  assert.deepEqual(positions.map((position) => [position.symbol, position.qty]), [["QQQ", 123_750_000], ["SPY", 99_000_000]], "$49,500 each");

  h.state.now = nyInstant(MON, 11, 0);
  h.state.prices.SPY = 450; // a 10% drop must not make the control trade
  assert.equal((await h.jobs.tick(h.state.now)) ?? null, null);
  h.state.now = nyInstant("2026-12-01", 10, 0);
  await h.jobs.tick(h.state.now);
  const orders = await h.client.query("SELECT symbol, side FROM orders WHERE account_id = ? ORDER BY submitted_at", [control.accountId]);
  assert.deepEqual(orders.map((order) => `${order.side} ${order.symbol}`).sort(), ["buy QQQ", "buy SPY"], "two buys, no sells, ever");
});

test("Discovery runs once per trading day at 10:00 ET, only when switched on, never on a holiday or weekend", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant("2026-11-25", 10, 5) });
  await h.jobs.tick(h.state.now);
  assert.equal(h.discoveryCalls.length, 0, "off by default");
  await h.jobs.setAutomation({ discoverySchedule: true });
  for (const [date, hour, minute] of [["2026-11-25", 9, 59], ["2026-11-26", 10, 30], ["2026-11-28", 10, 30], ["2026-11-25", 16, 5]]) {
    h.state.now = nyInstant(date, hour, minute);
    await h.jobs.tick(h.state.now);
  }
  assert.equal(h.discoveryCalls.length, 0, "before 10:00, Thanksgiving, Saturday and after the close all skip");
  for (const minute of [0, 1, 30]) {
    h.state.now = nyInstant("2026-11-27", 10, minute);
    await h.jobs.tick(h.state.now);
  }
  assert.equal(h.discoveryCalls.length, 1, "exactly once on a trading day");
  assert.deepEqual(h.discoveryCalls[0].params, {}, "the balanced preset");
  const [job] = await h.repositories.swarmExperiments.listJobRuns(5);
  assert.deepEqual([job.job, job.slot, job.status, job.detailJson.runId], ["discovery", "2026-11-27", "completed", "run-1"]);
});

test("after the close every arm gets an equity snapshot and SPY/QQQ closes are stored", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant("2026-11-27", 18, 0) });
  const { experiment, arms } = await h.experiments.createExperiment({ name: "disc" });
  h.state.bars.SPY = [{ time: Date.UTC(2026, 10, 27, 5), close: 500 }, { time: Date.UTC(2026, 10, 30, 5), close: 505 }];
  h.state.bars.QQQ = [{ time: Date.UTC(2026, 10, 27, 5), close: 400 }, { time: Date.UTC(2026, 10, 30, 5), close: 404 }];
  h.state.now = nyInstant(MON, 10, 0);
  await h.jobs.tick(h.state.now); // control buys
  h.state.now = nyInstant(MON, 16, 5);
  assert.equal((await h.jobs.tick(h.state.now))?.find?.((entry) => entry.job === "snapshot") ?? null, null, "not before 16:10");
  h.state.prices = { SPY: 505, QQQ: 404 };
  h.state.now = nyInstant(MON, 16, 12);
  const ran = await h.jobs.tick(h.state.now);
  assert.ok(ran.find((entry) => entry.job === "snapshot").results.every((result) => result.ok));
  for (const arm of arms) assert.equal((await h.repositories.swarmExperiments.listSnapshots(arm.id)).length, 1);
  const comparison = await h.experiments.comparison(experiment.id);
  const control = comparison.arms.find((row) => row.label === "control-index");
  assert.equal(control.spyReturnPct, 1);
  assert.equal(control.qqqReturnPct, 1);
  assert.equal(control.returnPct, 0.99, "99% invested, both up 1%");
  assert.equal(control.tooEarlyToCall, true);
  const growth = comparison.arms.find((row) => row.label === "disc-growth");
  assert.equal(growth.returnPct, 0, "an agent with no trades holds cash");
});
