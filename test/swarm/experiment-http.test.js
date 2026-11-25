import assert from "node:assert/strict";
import test from "node:test";

import { bootStockbot } from "./fixture.js";

test("operator API: create an experiment, read it, toggle automation; agents and anonymous callers are refused", async (t) => {
  const hub = await bootStockbot(t);
  assert.equal((await hub.call("GET", "/swarm/experiments")).status, 401);
  const automation = await hub.operator("GET", "/swarm/automation");
  assert.deepEqual(automation.data, { discoverySchedule: false, review: false, discoveryPreset: "balanced" });
  const created = await hub.operator("POST", "/swarm/experiments", { name: "disc" });
  assert.equal(created.status, 201, JSON.stringify(created.error));
  assert.deepEqual(created.data.agents, ["disc-growth", "disc-hold"]);

  const { api } = await hub.provisionAgent("alpha");
  assert.equal((await api("GET", "/../swarm/experiments")).status >= 400, true);

  const list = await hub.operator("GET", "/swarm/experiments");
  assert.deepEqual(list.data[0].arms.map((arm) => arm.label), ["disc-growth", "disc-hold", "control-index"]);
  const detail = await hub.operator("GET", `/swarm/experiments/${created.data.experiment.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.arms.length, 3);
  assert.ok(detail.data.arms.every((row) => row.tooEarlyToCall));
  assert.equal((await hub.operator("GET", "/swarm/experiments/disc/comparison")).status, 200, "by name too");
  assert.equal((await hub.operator("GET", "/swarm/experiments/nope")).status, 404);

  const on = await hub.operator("POST", "/swarm/automation", { discoverySchedule: true, review: true });
  assert.deepEqual(on.data, { discoverySchedule: true, review: true, discoveryPreset: "balanced" });
  assert.equal((await hub.operator("POST", "/swarm/automation", { bogus: 1 })).status, 400);
  const forced = await hub.operator("POST", "/swarm/experiments/disc/review", {});
  assert.equal(forced.status, 200, JSON.stringify(forced.error));
});
