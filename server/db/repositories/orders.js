import { assertClient, boundedLimit, first, hydrateRows, requireFields } from "./_helpers.js";

export function createOrdersRepository(client) {
  assertClient(client);

  const repository = {
    async create(input) {
      requireFields(
        input,
        ["id", "clientOrderId", "accountId", "symbol", "side", "qty", "status"],
        "order"
      );
      await client.execute(
        `INSERT INTO orders (
          id, client_order_id, session_id, account_id, symbol, side, order_type,
          qty, limit_price, status, reject_reason, signal_reason, signal_bar_at,
          submitted_at, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_order_id) DO NOTHING`,
        [
          input.id,
          input.clientOrderId,
          input.sessionId ?? null,
          input.accountId,
          input.symbol,
          input.side,
          input.orderType ?? "market",
          input.qty,
          input.limitPrice ?? null,
          input.status,
          input.rejectReason ?? null,
          input.signalReason ?? null,
          input.signalBarAt ?? null,
          input.submittedAt ?? Date.now(),
          input.resolvedAt ?? null
        ]
      );
      return repository.getByClientOrderId(input.clientOrderId);
    },

    async getById(id) {
      return first(await client.query("SELECT * FROM orders WHERE id = ?", [id]));
    },

    async getByClientOrderId(clientOrderId) {
      return first(await client.query("SELECT * FROM orders WHERE client_order_id = ?", [clientOrderId]));
    },

    async list(options = {}) {
      const clauses = [];
      const params = [];
      for (const [option, column] of [
        ["accountId", "account_id"],
        ["sessionId", "session_id"],
        ["symbol", "symbol"],
        ["status", "status"]
      ]) {
        if (options[option]) {
          clauses.push(`${column} = ?`);
          params.push(options[option]);
        }
      }
      if (options.beforeSubmittedAt !== undefined) {
        clauses.push("submitted_at < ?");
        params.push(options.beforeSubmittedAt);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit));
      return hydrateRows(
        await client.query(`SELECT * FROM orders ${where} ORDER BY submitted_at DESC, id DESC LIMIT ?`, params)
      );
    },

    async resolve(id, status, options = {}) {
      const result = await client.execute(
        `UPDATE orders SET
          status = ?,
          reject_reason = COALESCE(?, reject_reason),
          resolved_at = COALESCE(?, resolved_at)
         WHERE id = ?`,
        [status, options.rejectReason ?? null, options.resolvedAt ?? Date.now(), id]
      );
      return result.changes > 0 ? repository.getById(id) : null;
    },

    async addFill(input) {
      requireFields(input, ["id", "orderId", "qty", "price", "referencePrice"], "fill");
      await client.execute(
        `INSERT INTO fills
          (id, order_id, qty, price, reference_price, commission, filled_at, quote_age_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.id,
          input.orderId,
          input.qty,
          input.price,
          input.referencePrice,
          input.commission ?? 0,
          input.filledAt ?? Date.now(),
          input.quoteAgeMs ?? null
        ]
      );
      return first(await client.query("SELECT * FROM fills WHERE id = ?", [input.id]));
    },

    async recordFill(input, options = {}) {
      return client.transaction(async (transaction) => {
        const scoped = createOrdersRepository(transaction);
        const fill = await scoped.addFill(input);
        const order = await scoped.resolve(input.orderId, options.orderStatus ?? "filled", {
          resolvedAt: options.resolvedAt ?? input.filledAt ?? Date.now()
        });
        return { order, fill };
      });
    },

    async listFills(options = {}) {
      const clauses = [];
      const params = [];
      if (options.orderId) {
        clauses.push("fills.order_id = ?");
        params.push(options.orderId);
      }
      if (options.sessionId) {
        clauses.push("orders.session_id = ?");
        params.push(options.sessionId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit, 100, 1_000));
      return hydrateRows(
        await client.query(
          `SELECT fills.* FROM fills
           JOIN orders ON orders.id = fills.order_id
           ${where}
           ORDER BY fills.filled_at DESC, fills.id DESC LIMIT ?`,
          params
        )
      );
    },

    async createPositionLot(input) {
      requireFields(
        input,
        ["id", "accountId", "symbol", "qtyOpen", "qtyOriginal", "entryPrice", "openedAt"],
        "position lot"
      );
      await client.execute(
        `INSERT INTO position_lots (
          id, session_id, account_id, symbol, qty_open, qty_original,
          entry_price, entry_order_id, exit_price, exit_order_id,
          realized_pnl, opened_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.sessionId ?? null,
          input.accountId,
          input.symbol,
          input.qtyOpen,
          input.qtyOriginal,
          input.entryPrice,
          input.entryOrderId ?? null,
          input.exitPrice ?? null,
          input.exitOrderId ?? null,
          input.realizedPnl ?? null,
          input.openedAt,
          input.closedAt ?? null
        ]
      );
      return first(await client.query("SELECT * FROM position_lots WHERE id = ?", [input.id]));
    },

    async closePositionLot(id, input) {
      requireFields(input, ["exitPrice", "exitOrderId", "realizedPnl", "closedAt"], "position lot close");
      const result = await client.execute(
        `UPDATE position_lots SET
          qty_open = 0,
          exit_price = ?,
          exit_order_id = ?,
          realized_pnl = ?,
          closed_at = ?
         WHERE id = ? AND closed_at IS NULL`,
        [input.exitPrice, input.exitOrderId, input.realizedPnl, input.closedAt, id]
      );
      return result.changes > 0
        ? first(await client.query("SELECT * FROM position_lots WHERE id = ?", [id]))
        : null;
    },

    async listOpenLots(accountId, options = {}) {
      const params = [accountId];
      const clauses = [];
      if (options.symbol) {
        clauses.push("symbol = ?");
        params.push(options.symbol);
      }
      if (options.sessionId) {
        clauses.push("session_id = ?");
        params.push(options.sessionId);
      }
      const filter = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit, 250, 2_000));
      return hydrateRows(
        await client.query(
          `SELECT * FROM position_lots
           WHERE account_id = ? AND closed_at IS NULL ${filter}
           ORDER BY opened_at, id LIMIT ?`,
          params
        )
      );
    }
  };

  return Object.freeze(repository);
}
