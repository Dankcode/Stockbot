import { assertClient, booleanInteger, hydrateRow, hydrateRows, requireFields } from "./_helpers.js";

function settingRow(row) {
  const value = hydrateRow(row);
  return value ? { ...value, isSecret: Boolean(value.isSecret) } : null;
}

export function createSettingsRepository(client) {
  assertClient(client);

  const repository = {
    async get(key) {
      const rows = await client.query("SELECT key, value, is_secret, updated_at FROM settings WHERE key = ?", [key]);
      return settingRow(rows[0]);
    },

    async list() {
      const rows = await client.query("SELECT key, value, is_secret, updated_at FROM settings ORDER BY key");
      return hydrateRows(rows).map((row) => ({ ...row, isSecret: Boolean(row.isSecret) }));
    },

    async set(input) {
      requireFields(input, ["key"], "setting");
      const updatedAt = input.updatedAt ?? Date.now();
      await client.execute(
        `INSERT INTO settings (key, value, is_secret, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           value = excluded.value,
           is_secret = excluded.is_secret,
           updated_at = excluded.updated_at`,
        [input.key, input.value ?? null, booleanInteger(input.isSecret), updatedAt]
      );
      return repository.get(input.key);
    },

    async setMany(settings, options = {}) {
      if (!Array.isArray(settings)) {
        throw new TypeError("settings must be an array.");
      }
      return client.transaction(async (transaction) => {
        const scoped = createSettingsRepository(transaction);
        const records = [];
        for (const setting of settings) {
          records.push(await scoped.set({ ...setting, updatedAt: setting.updatedAt ?? options.updatedAt ?? Date.now() }));
        }
        return records;
      });
    },

    async remove(key) {
      const result = await client.execute("DELETE FROM settings WHERE key = ?", [key]);
      return result.changes > 0;
    }
  };

  return Object.freeze(repository);
}

