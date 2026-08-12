import assert from "node:assert/strict";
import test from "node:test";
import { createStockbot } from "../../server/bootstrap.js";
import { loadConfig } from "../../server/config/index.js";
import { createClient } from "../../server/db/client.js";
import { mutationAuth, requestContext, sendData } from "../../server/http/middleware.js";

test("modular server boots with versioned envelopes and protects mutations", async (t) => {
  const client = await createClient("file::memory:");
  const apiToken = "integration-token-that-is-at-least-32-characters";
  const config = {
    ...loadConfig(),
    databaseUrl: "file::memory:",
    apiToken,
    engineWorkers: 1,
    engineTimeoutMs: 2_000
  };
  const market = {
    providerHealth: () => [],
    clearCaches() {},
    async getBars() { throw new Error("No real fixture bars requested."); },
    async getQuote() { throw new Error("No real fixture quote requested."); },
    async search() { return []; },
    async movers() { return []; }
  };
  const runtime = await createStockbot({ config, client, market });
  t.after(async () => {
    await runtime.close();
  });
  assert.equal(typeof runtime.app, "function");
  assert.deepEqual(await runtime.database.health(), { ok: true, dialect: "sqlite" });
  assert.equal((await runtime.algorithms.list()).algorithms.length, 3);

  let denied;
  mutationAuth(config)(
    { method: "POST", get: () => "" },
    {},
    (error) => { denied = error; }
  );
  assert.equal(denied.code, "AUTH_REQUIRED");
  assert.equal(denied.status, 401);

  let allowed = false;
  mutationAuth(config)(
    { method: "POST", get: (name) => name === "x-stockbot-token" ? apiToken : "" },
    {},
    (error) => { assert.equal(error, undefined); allowed = true; }
  );
  assert.equal(allowed, true);

  const response = {
    locals: {},
    setHeader() {},
    json(payload) { this.payload = payload; }
  };
  requestContext({ get: () => "request-1" }, response, () => {});
  sendData(response, { ok: true });
  assert.deepEqual(response.payload, { data: { ok: true }, meta: { requestId: "request-1" } });
});
