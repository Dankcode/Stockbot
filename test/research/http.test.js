import assert from "node:assert/strict";
import test from "node:test";

import { operatorAuth } from "../../server/http/middleware.js";
import { researchRouter } from "../../server/http/routes/research.js";

const TOKEN = "research-http-token-that-is-at-least-32-chars";

function invoke(middleware, supplied = "") {
  let result = Symbol("not-called");
  middleware({ get: (name) => name === "x-stockbot-token" ? supplied : "" }, {}, (error) => {
    result = error;
  });
  return result;
}

test("research operator auth protects reads as well as mutations", () => {
  const auth = operatorAuth({ apiToken: TOKEN });
  assert.equal(invoke(auth, TOKEN), undefined);
  assert.equal(invoke(auth)?.code, "AUTH_REQUIRED");
  assert.equal(invoke(auth, `${TOKEN}x`)?.status, 401);
});

test("research routes install operator auth first and fail closed when it is unconfigured", () => {
  const router = researchRouter({
    adapters: { list: () => [] },
    async listPlans() { return []; },
    async listRuns() { return []; }
  }, { apiToken: "" });

  assert.equal(router.stack[0].route, undefined);
  const failure = invoke(router.stack[0].handle);
  assert.equal(failure.code, "AUTH_NOT_CONFIGURED");
  assert.equal(failure.status, 503);
  assert.equal(router.stack.some((layer) => layer.route?.path === "/adapters"), true);
});
