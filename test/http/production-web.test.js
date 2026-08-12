import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { mountProductionWeb } from "../../server/http/app.js";

test("production web mount installs static assets before an API-safe SPA fallback", () => {
  const app = express();
  assert.equal(mountProductionWeb(app, { workspaceRoot: "/srv/stockbot", nodeEnv: "production" }), true);

  const [staticLayer, spaLayer] = app.router.stack;
  assert.equal(staticLayer.name, "serveStatic");
  assert.equal(spaLayer.route.path instanceof RegExp, true);
  assert.equal(spaLayer.route.methods.get, true);
  assert.equal(spaLayer.route.path.test("/sessions/example"), true);
  assert.equal(spaLayer.route.path.test("/api/v1/health"), false);
  assert.equal(spaLayer.route.path.test("/api"), false);
});

test("development mode does not mount the production build", () => {
  const app = express();
  assert.equal(mountProductionWeb(app, { workspaceRoot: "/unused", nodeEnv: "development" }), false);
  assert.equal(app.router.stack.length, 0);
});

test("production mount requires an explicit workspace root", () => {
  assert.throws(() => mountProductionWeb(express(), { nodeEnv: "production" }), /workspaceRoot/);
});
