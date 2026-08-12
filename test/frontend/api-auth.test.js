import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ApiRequestError, apiRequest } from "../../src/lib/api.ts";
import {
  SESSION_API_TOKEN_STORAGE_KEY,
  clearSessionApiToken,
  createSessionTokenStore,
  setSessionApiToken
} from "../../src/lib/sessionAuth.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearSessionApiToken();
});

function successResponse() {
  return new Response(JSON.stringify({ data: { ok: true }, meta: { requestId: "test-request" } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("session token store persists only through the supplied session storage", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const first = createSessionTokenStore(storage);
  let notifications = 0;
  const unsubscribe = first.subscribe(() => { notifications += 1; });

  first.set("  test-session-token-with-at-least-32-chars  ");
  assert.equal(first.isConfigured(), true);
  assert.equal(values.get(SESSION_API_TOKEN_STORAGE_KEY), "test-session-token-with-at-least-32-chars");
  assert.equal(createSessionTokenStore(storage).isConfigured(), true);
  assert.equal(notifications, 1);

  first.clear();
  assert.equal(first.get(), "");
  assert.equal(values.has(SESSION_API_TOKEN_STORAGE_KEY), false);
  assert.equal(notifications, 2);
  unsubscribe();
});

test("api client sends the session token only on mutating methods", async () => {
  const observed = [];
  globalThis.fetch = async (_url, init = {}) => {
    observed.push({ method: init.method ?? "GET", headers: new Headers(init.headers) });
    return successResponse();
  };
  setSessionApiToken("test-session-token-with-at-least-32-chars");

  await apiRequest("/read");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    await apiRequest("/mutation", { method, body: "{}" });
  }

  assert.equal(observed[0].headers.get("x-stockbot-token"), null);
  for (const request of observed.slice(1)) {
    assert.equal(request.headers.get("x-stockbot-token"), "test-session-token-with-at-least-32-chars");
  }
});

test("api client omits the mutation header after the session token is cleared", async () => {
  let headers = new Headers();
  globalThis.fetch = async (_url, init = {}) => {
    headers = new Headers(init.headers);
    return successResponse();
  };
  setSessionApiToken("test-session-token-with-at-least-32-chars");
  clearSessionApiToken();

  await apiRequest("/mutation", { method: "POST", body: "{}" });
  assert.equal(headers.get("x-stockbot-token"), null);
});

for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "AUTH_FORBIDDEN"]]) {
  test(`${status} responses direct the operator to the Settings token control`, async () => {
    globalThis.fetch = async () => new Response("", { status });

    await assert.rejects(
      apiRequest("/mutation", { method: "POST", body: "{}" }),
      (error) => error instanceof ApiRequestError
        && error.status === status
        && error.code === code
        && /Settings/.test(error.message)
    );
  });
}
