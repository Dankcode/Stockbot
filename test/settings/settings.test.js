import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsService } from "../../server/settings/service.js";

function repository() {
  const rows = new Map();
  return {
    async list() { return [...rows.values()]; },
    async get(key) { return rows.get(key) || null; },
    async setMany(items) { items.forEach((item) => rows.set(item.key, { ...item, updatedAt: Date.now() })); }
  };
}

function config(key = "") {
  return { settingsEncryptionKey: key, alpaca: { key: "", secret: "", dataBaseUrl: "", stockFeed: "" }, polygon: { key: "" }, finnhub: { key: "" } };
}

test("secret settings require encryption key and never expose fragments", async () => {
  const missing = createSettingsService(repository(), config());
  await assert.rejects(() => missing.update({ ALPACA_API_KEY: "super-secret-key" }), /STOCKBOT_SETTINGS_KEY/);

  const repo = repository();
  const service = createSettingsService(repo, config("test-only-encryption-key"));
  const payload = await service.update({ ALPACA_API_KEY: "super-secret-key" });
  const field = payload.groups.flatMap((group) => group.fields).find((item) => item.key === "ALPACA_API_KEY");
  assert.deepEqual({ value: field.value, hasValue: field.hasValue }, { value: "", hasValue: true });
  assert.equal(await service.getInternal("ALPACA_API_KEY"), "super-secret-key");
  assert.match((await repo.get("ALPACA_API_KEY")).value, /^enc:v1:/);
  assert.doesNotMatch(JSON.stringify(payload), /secret-key/);
});
