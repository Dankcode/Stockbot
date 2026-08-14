import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../../server/config/index.js";

const KEYS = [
  "HOST",
  "DATABASE_URL",
  "STOCKBOT_DATABASE_LOCATION",
  "STOCKBOT_CONFIG_FILE",
  "STOCKBOT_ALLOW_REMOTE",
  "STOCKBOT_API_TOKEN",
  "STOCKBOT_SETTINGS_KEY"
];

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

test("configuration exposes its protected source and infers provider-neutral database location", () => {
  withEnvironment({
    DATABASE_URL: "postgresql://stockbot:secret@localhost/stockbot",
    STOCKBOT_CONFIG_FILE: "/private/stockbot.env"
  }, () => {
    const config = loadConfig();
    assert.equal(config.configFile, "/private/stockbot.env");
    assert.equal(config.databaseLocation, "local");
  });
  withEnvironment({
    DATABASE_URL: "postgresql://stockbot:secret@db.internal.example/stockbot"
  }, () => assert.equal(loadConfig().databaseLocation, "remote"));
  withEnvironment({ STOCKBOT_DATABASE_LOCATION: "public-cloud" }, () => {
    assert.throws(loadConfig, /local or remote/);
  });
});
