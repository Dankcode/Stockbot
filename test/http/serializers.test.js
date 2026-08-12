import assert from "node:assert/strict";
import test from "node:test";
import { SessionSchema } from "../../packages/shared/schemas.js";
import { sessionCompareResource, sessionResource } from "../../server/http/serializers.js";

const persistedSession = {
  id: "session-1",
  accountId: "default-paper",
  name: "Canonical session",
  mode: "paper",
  status: "running",
  algorithmVersionId: "algorithm:v1",
  paramsJson: { fast: 9 },
  symbolsJson: ["SPY"],
  barInterval: "5min",
  windowStart: null,
  windowEnd: null,
  fillModelJson: { slippageBps: 5 },
  riskProfileJson: {},
  scheduleJson: { type: "market_hours", timezone: "America/New_York" },
  startingEquity: 10_000_000,
  endingEquity: null,
  startedAt: 1_786_200_000_000,
  endedAt: null,
  stopReason: null,
  errorDetail: null,
  createdAt: 1_786_199_000_000
};

test("session persistence aliases do not leak through the API resource", () => {
  const resource = sessionResource(persistedSession);
  assert.deepEqual(SessionSchema.parse(resource), resource);
  assert.equal("paramsJson" in resource, false);
  assert.deepEqual(resource.symbols, ["SPY"]);
});

test("comparison resources canonicalize sessions, details, and config keys", () => {
  const resource = sessionCompareResource({
    sessions: [{ ...persistedSession, metrics: null }],
    details: [{ session: persistedSession, metrics: null, equity: [] }],
    curves: [],
    configDiff: { paramsJson: { "session-1": { fast: 9 } } }
  });
  assert.equal(resource.sessions[0].paramsJson, undefined);
  assert.equal(resource.details[0].session.symbolsJson, undefined);
  assert.deepEqual(resource.configDiff.params, { "session-1": { fast: 9 } });
});
