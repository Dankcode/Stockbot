import assert from "node:assert/strict";
import test from "node:test";

import { SWARM_CEILINGS } from "../../packages/shared/swarm.js";
import { nyInstant, tradingDatesBetween } from "../../server/swarm/calendar.js";
import { experimentHarness } from "./experiment-fixture.js";

const START = "2026-11-30";
const DATES = tradingDatesBetween(START, "2027-04-30").slice(0, 60);
const DAY59 = DATES[58];
const DAY60 = DATES[59];

function seeded(seed) {
  let state = seed;
  return () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
}

/** Writes a filled order (and, for agents, its filled intent with entry features). */
async function fill(h, { account, agentId, symbol, side, shares, price, at, features }) {
  const id = h.idFactory();
  await h.client.execute(
    `INSERT INTO orders (id, client_order_id, account_id, symbol, side, qty, status, signal_reason, submitted_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, 'filled', 'seed', ?, ?)`,
    [`o-${id}`, `seed:${id}`, account, symbol, side, shares * 1_000_000, at, at]
  );
  await h.client.execute(
    "INSERT INTO fills (id, order_id, qty, price, reference_price, commission, filled_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [`f-${id}`, `o-${id}`, shares * 1_000_000, Math.round(price * 100), Math.round(price * 100), at]
  );
  if (agentId) {
    await h.client.execute(
      `INSERT INTO agent_intents (id, agent_id, idempotency_key, request_hash, symbol, side, qty, status, client_order_id, order_id, attempts, created_at, updated_at, entry_features_json)
       VALUES (?, ?, ?, 'h', ?, ?, ?, 'filled', ?, ?, 1, ?, ?, ?)`,
      [`i-${id}`, agentId, `seed-${id}`, symbol, side, shares * 1_000_000, `intent:${id}`, `o-${id}`, at, at,
        side === "buy" ? JSON.stringify({ source: "discovery", lens: "hold", rank: 1, features }) : null]
    );
  }
}

/**
 * 60 trading days: SPY +0.05%/day; the control tracks it; growth trails the
 * control by ~0.1%/day every day (a clear deficit, never the floor); hold is the
 * control ± 1% noise. 40 closed hold trades where mom6m truly predicts beating
 * SPY and vol1y truly hurts.
 */
async function seed(h) {
  const { experiment, arms } = await h.experiments.createExperiment({ name: "disc", startDate: START });
  const arm = Object.fromEntries(arms.map((entry) => [entry.label, entry]));
  const store = h.repositories.swarmExperiments;
  await store.putBenchmarkClose({ symbol: "SPY", date: "2026-11-27", close: 500, source: "seed", fetchedAt: 0 });
  await store.putBenchmarkClose({ symbol: "QQQ", date: "2026-11-27", close: 400, source: "seed", fetchedAt: 0 });
  let control = 10_000_000;
  let growth = 10_000_000;
  const noise = seeded(5);
  for (const [index, date] of DATES.entries()) {
    await store.putBenchmarkClose({ symbol: "SPY", date, close: 500 * 1.0005 ** (index + 1), source: "seed", fetchedAt: 0 });
    await store.putBenchmarkClose({ symbol: "QQQ", date, close: 400 * 1.0005 ** (index + 1), source: "seed", fetchedAt: 0 });
    control *= 1.0005;
    growth *= 1.0005 - 0.001 + (noise() - 0.5) * 0.0004;
    const hold = control * (1 + (index % 2 ? 0.01 : -0.01));
    const put = (label, equity) => store.putSnapshot({ armId: arm[label].id, date, equity: Math.round(equity), cash: 0, positions: [], takenAt: 0 });
    await put("control-index", control);
    await put("disc-growth", growth);
    await put("disc-hold", hold);
  }
  const random = seeded(11);
  for (let trade = 0; trade < 40; trade += 1) {
    const mom6m = random() * 0.6 - 0.1;
    const vol1y = 0.2 + random() * 0.6;
    const excess = 0.4 * (mom6m - 0.2) - 0.3 * (vol1y - 0.5) + (random() - 0.5) * 0.02;
    const entryDate = DATES[trade];
    const exitDate = DATES[trade + 5];
    const spy = 1.0005 ** 5;
    const exitPrice = 100 * (spy + excess);
    await fill(h, { account: arm["disc-hold"].accountId, agentId: arm["disc-hold"].agentId, symbol: `T${trade}`, side: "buy", shares: 10, price: 100, at: nyInstant(entryDate, 11, 0), features: { mom6m, vol1y, rsi14: random() * 100 } });
    await fill(h, { account: arm["disc-hold"].accountId, agentId: arm["disc-hold"].agentId, symbol: `T${trade}`, side: "sell", shares: 10, price: exitPrice, at: nyInstant(exitDate, 11, 0) });
  }
  return { experiment, arm };
}

test("day 59: a trailing arm is not retired; day 60: it is, lessons are learned and a learned arm starts", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant(DAY59, 16, 40) });
  const { experiment, arm } = await seed(h);

  const early = await h.review.run(experiment.id, DAY59);
  assert.equal(early.reviewed, false, "day 59 is not a review day and nothing hit the floor");
  assert.equal((await h.repositories.swarmExperiments.getArm(arm["disc-growth"].id)).status, "active");

  h.state.now = nyInstant(DAY60, 16, 40);
  const result = await h.review.run(experiment.id, DAY60);
  assert.equal(result.reviewed, true);
  assert.equal(result.tradingDays, 60);
  const verdict = Object.fromEntries(result.verdicts.map((row) => [row.label, row]));
  assert.equal(verdict["disc-growth"].verdict, "below-passive");
  assert.match(verdict["disc-growth"].action, /^retired/);
  assert.equal(verdict["disc-hold"].verdict, "inside-noise", "noise around the control keeps running");
  assert.equal(verdict["control-index"].verdict, "control");
  assert.equal((await h.repositories.swarmExperiments.getArm(arm["disc-growth"].id)).status, "retired");
  assert.equal((await h.repositories.swarm.getAgent(arm["disc-growth"].agentId)).status, "retired", "its agent stops and loses its tokens");
  assert.equal((await h.repositories.swarmExperiments.getArm(arm["control-index"].id)).status, "active");

  assert.equal(result.lessons.tradeCount, 40);
  const stable = result.lessons.features.filter((feature) => feature.stable).map((feature) => feature.key).sort();
  assert.deepEqual(stable, ["mom6m", "vol1y"], "the planted inputs, not the noise");
  assert.equal(result.lessons.base, "hold", "the better arm's lens is the base");
  assert.ok(result.lessons.model.exclude.some((rule) => rule.metric === "vol1y" && rule.condition === "greater_than"));

  assert.equal(result.createdArm.label, "disc-learned-v1");
  assert.equal(result.createdArm.startDate, "2027-02-26", "starts the next trading day with a fresh sleeve");
  const learnedPlan = (await h.repositories.swarm.getActivePlan(result.createdArm.agentId)).planJson;
  assert.equal(learnedPlan.universe.discovery.score, "learned");
  assert.deepEqual(learnedPlan.universe.symbols, ["SPY"]);
  assert.equal(learnedPlan.universe.discovery.top, 9);
  assert.equal(Number((await h.repositories.accounts.getById(result.createdArm.accountId)).startingCash), 10_000_000);

  const [stored] = await h.repositories.swarmExperiments.listReviews(experiment.id);
  assert.equal(stored.createdArmId, result.createdArm.id);
  assert.match(stored.lessonsMd, /# Swarm review 2027-02-25/);
  assert.match(stored.lessonsMd, /disc-growth \| below-passive/);
  assert.match(stored.lessonsMd, /score \+ agent/);

  assert.equal((await h.review.run(experiment.id, DAY60)).duplicate, true, "one review per date");
});

test("the floor retires an arm on any day, and a retired sleeve is sold to cash in the next session", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant(START, 10, 0) });
  const { experiment, arms } = await h.experiments.createExperiment({ name: "disc", startDate: START });
  const growth = arms.find((entry) => entry.label === "disc-growth");
  await h.broker.submitOrder({ clientOrderId: "seed:held", accountId: growth.accountId, symbol: "AAA", side: "buy", qty: 10_000_000 });
  const store = h.repositories.swarmExperiments;
  for (const [index, date] of DATES.slice(0, 5).entries()) {
    for (const entry of arms) {
      const equity = entry.label === "disc-growth" ? 10_000_000 * (1 - 0.06 * (index + 1)) : 10_000_000;
      await store.putSnapshot({ armId: entry.id, date, equity: Math.round(equity), cash: 0, positions: [], takenAt: 0 });
    }
  }
  const result = await h.review.run(experiment.id, DATES[4]);
  assert.equal(result.verdicts.find((row) => row.label === "disc-growth").verdict, "fails-floor", "-30% on day 5");
  assert.equal((await store.getArm(growth.id)).status, "retired");
  assert.equal(result.lessons.reason, "Learning waits for the scheduled review.");

  h.state.now = nyInstant(DATES[5], 10, 0);
  const ran = await h.jobs.tick(h.state.now);
  assert.equal(ran.find((entry) => entry.job === "liquidate").closed, 1);
  assert.deepEqual(await h.ledger.listOpenPositions(growth.accountId), []);
});

test("no learned arm past the 8-agent cap; the review says why", async (t) => {
  const h = await experimentHarness(t, { now: nyInstant(DAY60, 16, 40) });
  const { experiment, arm } = await seed(h);
  // Retiring an arm frees its agent slot, so retire growth first and then fill the swarm to the cap.
  await h.repositories.swarmExperiments.retireArm(arm["disc-growth"].id, { reason: "operator", at: h.state.now });
  await h.swarm.setAgentStatus(arm["disc-growth"].agentId, "retired");
  for (let index = 0; index < SWARM_CEILINGS.maxAgents - 1; index += 1) await h.swarm.createAgent({ name: `filler-${index}` });
  assert.equal(await h.repositories.swarm.countAgents(), SWARM_CEILINGS.maxAgents);
  const result = await h.review.run(experiment.id, DAY60);
  assert.equal(result.createdArm, null);
  assert.match(result.skipped, /already has 8 agents/);
  const [stored] = await h.repositories.swarmExperiments.listReviews(experiment.id);
  assert.match(stored.lessonsMd, /A learned arm was not started/);
});
