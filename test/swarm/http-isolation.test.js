import assert from "node:assert/strict";
import test from "node:test";

import { OPERATOR_TOKEN, bootStockbot } from "./fixture.js";

test("over real HTTP, an agent token reaches only its own agent and never operator routes", async (t) => {
  const hub = await bootStockbot(t);
  const a = await hub.provisionAgent("alpha");
  const b = await hub.provisionAgent("bravo");

  // Each agent has its own $100k sleeve; nothing landed in the default account.
  assert.equal(a.agent.accountId, "sleeve-alpha");
  assert.equal(b.agent.accountId, "sleeve-bravo");
  assert.equal((await a.api("GET", "/agent/portfolio")).data.cash, 10_000_000);
  assert.equal((await a.api("GET", "/agent/me")).data.id, "agent-alpha");
  assert.equal((await a.api("GET", "/agent/me")).data.intentsEnabled, false);

  const bTask = await hub.operator("POST", `/swarm/agents/${b.agent.id}/tasks`, {});
  assert.equal(bTask.status, 201);
  // A cannot see, claim, retrieve for, report on, or fail B's task, and gets the same 404 as for a missing id.
  for (const [method, path, body] of [
    ["POST", `/agent/tasks/${bTask.data.id}/claim`],
    ["POST", `/agent/tasks/${bTask.data.id}/retrievals`, { kind: "market.quote", symbol: "SPY" }],
    ["POST", `/agent/tasks/${bTask.data.id}/report`, { summary: "x", decisions: [{ symbol: "SPY", action: "hold", rationale: "x", evidence: ["r1"] }] }],
    ["POST", `/agent/tasks/${bTask.data.id}/fail`, {}],
    ["POST", "/agent/tasks/does-not-exist/claim"]
  ]) {
    const response = await a.api(method, path, body);
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(response.error.code, "TASK_NOT_FOUND");
  }
  assert.deepEqual((await a.api("GET", "/agent/tasks")).data, []);
  assert.equal((await b.api("GET", "/agent/tasks")).data.length, 1);

  // Agent tokens are not operator tokens: reads and writes on operator routes fail.
  for (const [method, path, body] of [
    ["GET", "/swarm"],
    ["POST", "/swarm/intents", { enabled: true }],
    ["POST", `/swarm/agents/${a.agent.id}/intents`, { enabled: true }],
    ["POST", "/sessions", {}],
    ["POST", "/algorithms", {}],
    ["POST", "/accounts/sleeve-alpha/orders", {}],
    ["GET", "/research/plans"]
  ]) {
    const response = await hub.call(method, path, { agentToken: a.token, body });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  // ...and the agent token in the operator header slot is not a valid operator token either.
  assert.equal((await hub.call("GET", "/swarm", { token: a.token })).status, 401);

  // The operator token is not an agent.
  assert.equal((await hub.call("GET", "/agent/me", { token: OPERATOR_TOKEN })).status, 401);
  assert.equal((await hub.call("GET", "/agent/me", { agentToken: OPERATOR_TOKEN })).status, 401);
  // Unknown agent paths end at the agent router's own 404 instead of falling through.
  assert.equal((await a.api("POST", "/agent/../sessions", {})).status, 401);
  assert.equal((await a.api("GET", "/agent/nothing-here")).status, 404);

  // Sleeves are not readable through the general accounts route without the operator token.
  assert.equal((await hub.call("GET", "/accounts/sleeve-bravo/portfolio")).status, 401);
  assert.equal((await hub.call("GET", "/accounts/sleeve-bravo/portfolio", { agentToken: a.token })).status, 401);
  assert.equal((await hub.operator("GET", "/accounts/sleeve-bravo/portfolio")).status, 200);
  assert.equal((await hub.call("GET", "/accounts/default-paper/portfolio")).status, 200, "the existing default account behaves as before");

  // Revocation and retirement take effect on the next request.
  assert.equal((await hub.operator("POST", `/swarm/agents/${a.agent.id}/tokens/revoke`)).data.revoked, 1);
  assert.equal((await a.api("GET", "/agent/me")).status, 401);
  assert.equal((await hub.operator("POST", `/swarm/agents/${b.agent.id}/status`, { status: "retired" })).status, 200);
  assert.equal((await b.api("GET", "/agent/me")).status, 401);
});

test("operator swarm routes fail closed without the operator token", async (t) => {
  const hub = await bootStockbot(t);
  assert.equal((await hub.call("GET", "/swarm")).status, 401);
  assert.equal((await hub.call("POST", "/swarm/agents", { body: { name: "x1" } })).status, 401);
  assert.equal((await hub.operator("GET", "/swarm")).data.intentsEnabled, false);
});
