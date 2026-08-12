import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../server/config/index.js";

const KEYS = ["HOST", "STOCKBOT_ALLOW_REMOTE", "STOCKBOT_API_TOKEN", "STOCKBOT_SETTINGS_KEY"];

function withEnvironment(values, callback) {
  const prior = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try { return callback(); }
  finally {
    for (const key of KEYS) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test("configuration defaults to loopback and rejects unsafe remote binding", () => {
  withEnvironment({}, () => assert.equal(loadConfig().host, "127.0.0.1"));
  withEnvironment({ HOST: "0.0.0.0" }, () => assert.throws(loadConfig, /loopback/));
  withEnvironment({ HOST: "0.0.0.0", STOCKBOT_ALLOW_REMOTE: "true" }, () => assert.throws(loadConfig, /API_TOKEN/));
  withEnvironment({
    HOST: "0.0.0.0",
    STOCKBOT_ALLOW_REMOTE: "true",
    STOCKBOT_API_TOKEN: "a-secure-remote-token-with-32-characters"
  }, () => assert.equal(loadConfig().host, "0.0.0.0"));
});

test("configured secrets fail closed when too short", () => {
  withEnvironment({ STOCKBOT_API_TOKEN: "short" }, () => assert.throws(loadConfig, /32 characters/));
  withEnvironment({ STOCKBOT_SETTINGS_KEY: "short" }, () => assert.throws(loadConfig, /32 characters/));
});
