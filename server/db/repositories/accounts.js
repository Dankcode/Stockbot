import { assertClient, boundedLimit, first, hydrateRows, requireFields } from "./_helpers.js";

export function createAccountsRepository(client) {
  assertClient(client);

  const repository = {
    async create(input) {
      requireFields(input, ["id", "name", "mode", "startingCash"], "account");
      const createdAt = input.createdAt ?? Date.now();
      await client.execute(
        `INSERT INTO accounts
          (id, name, mode, starting_cash, cash, realized_pnl, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.name,
          input.mode,
          input.startingCash,
          input.cash ?? input.startingCash,
          input.realizedPnl ?? 0,
          createdAt,
          input.archivedAt ?? null
        ]
      );
      return repository.getById(input.id);
    },

    async getById(id) {
      return first(await client.query("SELECT * FROM accounts WHERE id = ?", [id]));
    },

    async list(options = {}) {
      const limit = boundedLimit(options.limit);
      const rows = options.includeArchived
        ? await client.query("SELECT * FROM accounts ORDER BY created_at DESC, id LIMIT ?", [limit])
        : await client.query(
            "SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY created_at DESC, id LIMIT ?",
            [limit]
          );
      return hydrateRows(rows);
    },

    async updateBalances(id, changes) {
      if (!changes || typeof changes !== "object") {
        throw new TypeError("balance changes must be an object.");
      }
      const result = await client.execute(
        `UPDATE accounts
         SET cash = COALESCE(?, cash),
             realized_pnl = COALESCE(?, realized_pnl)
         WHERE id = ?`,
        [changes.cash ?? null, changes.realizedPnl ?? null, id]
      );
      return result.changes > 0 ? repository.getById(id) : null;
    },

    async adjustBalances(id, changes = {}) {
      const cashDelta = changes.cashDelta ?? 0;
      const realizedPnlDelta = changes.realizedPnlDelta ?? 0;
      const result = await client.execute(
        `UPDATE accounts
         SET cash = cash + ?,
             realized_pnl = realized_pnl + ?
         WHERE id = ? AND cash + ? >= 0`,
        [cashDelta, realizedPnlDelta, id, cashDelta]
      );
      return result.changes > 0 ? repository.getById(id) : null;
    },

    async archive(id, archivedAt = Date.now()) {
      const result = await client.execute("UPDATE accounts SET archived_at = ? WHERE id = ?", [archivedAt, id]);
      return result.changes > 0 ? repository.getById(id) : null;
    }
  };

  return Object.freeze(repository);
}

