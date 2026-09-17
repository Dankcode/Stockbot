import assert from "node:assert/strict";
import test from "node:test";

import { createExperimentService } from "../../server/experiments/service.js";

const PLAN = Object.freeze({
  kind: "stockbot.experiment.v1",
  symbol: "AAPL",
  range: "1Y",
  fillModel: {},
  arms: Object.freeze([
    Object.freeze({ key: "strategy::[]", id: "pack/strategy", algorithmId: "pack/strategy", kind: "strategy", params: {} }),
    Object.freeze({ key: "control::[[\"seed\",1]]", id: "controls/random#seed=1", algorithmId: "controls/random", kind: "control", params: { seed: 1 } })
  ]),
  groups: Object.freeze([
    Object.freeze({
      strategy: Object.freeze({ key: "strategy::[]" }),
      controls: Object.freeze([Object.freeze({ key: "control::[[\"seed\",1]]" })])
    })
  ])
});

function harness() {
  const experiments = new Map();
  const sessions = new Map();
  let sequence = 0;
  const algorithms = {
    async get(id) { return { id, enabled: true, version: { id: `${id}:v1` } }; }
  };
  const repositories = {
    algorithms: {},
    experiments: {
      async create(input) {
        const row = { ...input, fillModelJson: input.fillModel, planJson: input.plan, selectionJson: input.selection };
        experiments.set(input.id, row);
        return row;
      },
      async getById(id) { return experiments.get(id) ?? null; },
      async list() { return [...experiments.values()]; },
      async delete(id) {
        experiments.delete(id);
        for (const [sessionId, session] of sessions) if (session.experimentId === id) sessions.delete(sessionId);
      }
    },
    sessions: {
      async list({ experimentId }) { return [...sessions.values()].filter((session) => session.experimentId === experimentId); },
      async getById(id) { return sessions.get(id) ?? null; },
      async getMetrics(id) { return sessions.get(id)?.metrics ?? null; }
    }
  };
  const supervisor = {
    async create(input) {
      const session = { id: `session-${++sequence}`, status: "draft", ...input, metrics: null };
      sessions.set(session.id, session);
      return session;
    },
    async start(id) {
      const session = sessions.get(id);
      session.status = "stopped";
      session.metrics = { returnPercent: session.experimentArm === "strategy" ? 4 : 1, sharpe: 1.2, maxDrawdown: 2, tradeCount: 8, exposurePercent: 50 };
      return session;
    },
    async halt(id) { const session = sessions.get(id); session.status = "halted"; return { session, idempotent: false, liquidation: null }; }
  };
  return { service: createExperimentService({ repositories, algorithms, supervisor, accountId: "account-1", idFactory: () => "experiment-1", clock: () => 100 }), sessions };
}

test("experiment service persists version bindings and creates one sibling session per arm", async () => {
  const { service, sessions } = harness();
  const created = await service.create({ name: "AAPL test", mode: "backtest", plan: PLAN });
  assert.equal(created.experiment.id, "experiment-1");
  assert.equal(created.sessions.length, 2);
  assert.equal(created.experiment.planJson.versionBindings["strategy::[]"], "pack/strategy:v1");
  assert.deepEqual([...sessions.values()].map((session) => session.experimentArm).sort(), ["control", "strategy"]);
  assert.ok([...sessions.values()].every((session) => session.experimentId === "experiment-1"));
});

test("experiment service starts, halts and reports its sibling arms", async () => {
  const { service } = harness();
  await service.create({ name: "AAPL test", mode: "backtest", plan: PLAN });
  const started = await service.start("experiment-1");
  assert.equal(started.outcomes.length, 2);
  assert.ok(started.outcomes.every((outcome) => outcome.error === null));
  const result = await service.report("experiment-1");
  assert.equal(result.report.executedCount, 2);
  assert.equal(result.report.groups[0].metrics.returnPercent, 4);
  const halted = await service.halt("experiment-1");
  assert.ok(halted.outcomes.every((outcome) => outcome.session.status === "halted"));
});
