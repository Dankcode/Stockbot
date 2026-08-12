import { randomUUID } from "node:crypto";
import { createRepositories } from "../db/repositories/index.js";
import { AppError } from "../http/errors.js";
import { isCryptoSymbol } from "../market/catalog.js";

export const DEFAULT_ACCOUNT_ID = "default-paper";
export const DEFAULT_STARTING_CASH = 10_000_000;
const MICROSHARES = 1_000_000n;

function integer(value, label, { positive = false, nonnegative = false } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || (positive && number <= 0) || (nonnegative && number < 0)) {
    throw new TypeError(`${label} must be a ${positive ? "positive " : nonnegative ? "non-negative " : ""}safe integer.`);
  }
  return number;
}

function safeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`${label} exceeds the safe integer range.`);
  return number;
}

function roundedDivision(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  return sign * ((absolute + denominator / 2n) / denominator);
}

export function notionalCents(priceCents, qtyMicros) {
  const price = BigInt(integer(priceCents, "priceCents", { positive: true }));
  const quantity = BigInt(integer(qtyMicros, "qtyMicros", { positive: true }));
  return safeNumber(roundedDivision(price * quantity, MICROSHARES), "notional");
}

function signedNotionalCents(priceDeltaCents, qtyMicros) {
  const delta = BigInt(integer(priceDeltaCents, "priceDeltaCents"));
  const quantity = BigInt(integer(qtyMicros, "qtyMicros", { positive: true }));
  return safeNumber(roundedDivision(delta * quantity, MICROSHARES), "signed notional");
}

export function dollarsToCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError("Price must be positive and finite.");
  return integer(Math.round(number * 100), "price cents", { positive: true });
}

function hydrateRow(row) {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value])
  );
}

function sumIntegers(values, label) {
  return safeNumber(values.reduce((sum, value) => sum + BigInt(value), 0n), label);
}

function allocateProportion(total, through, denominator) {
  if (total === 0 || through === 0) return 0;
  return safeNumber(
    roundedDivision(BigInt(total) * BigInt(through), BigInt(denominator)),
    "commission allocation"
  );
}

function executionError(code, message, status = 400, detail) {
  return new AppError(code, message, status, detail);
}

async function sessionCashCents(database, sessionId, { lock = false } = {}) {
  const [session] = await database.query(
    `SELECT starting_equity FROM sessions WHERE id = ?${lock && database.dialect === "postgres" ? " FOR UPDATE" : ""}`,
    [sessionId]
  );
  if (!session) throw executionError("SESSION_NOT_FOUND", `Unknown session: ${sessionId}`, 404);
  const fills = await database.query(
    `SELECT orders.side, fills.qty, fills.price, fills.commission
     FROM fills JOIN orders ON orders.id = fills.order_id
     WHERE orders.session_id = ?`,
    [sessionId]
  );
  let cash = BigInt(session.starting_equity);
  for (const fill of fills) {
    const gross = BigInt(notionalCents(Number(fill.price), Number(fill.qty)));
    const commission = BigInt(fill.commission);
    cash += fill.side === "buy" ? -(gross + commission) : gross - commission;
  }
  return safeNumber(cash, "session cash");
}

function assertSameOrder(order, input, qty) {
  const expected = {
    accountId: input.accountId,
    sessionId: input.sessionId ?? null,
    symbol: String(input.symbol).toUpperCase(),
    side: input.side,
    qty
  };
  const conflict = Object.entries(expected).find(([key, value]) => (order[key] ?? null) !== value);
  if (conflict) {
    throw executionError(
      "IDEMPOTENCY_CONFLICT",
      `clientOrderId ${input.clientOrderId} is already associated with a different order.`,
      409,
      { field: conflict[0] }
    );
  }
}

function timezoneOffset(at, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  ) - at;
}

function startOfDay(at, timeZone) {
  const calendar = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(
    calendar.formatToParts(at).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  const utcGuess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  let result = utcGuess - timezoneOffset(utcGuess, timeZone);
  result = utcGuess - timezoneOffset(result, timeZone);
  return result;
}

export function createLedger({ client, repositories = createRepositories(client), clock = () => Date.now(), idFactory = randomUUID }) {
  if (!client?.transaction) throw new TypeError("Ledger requires a transactional database client.");

  async function ensureDefaultAccount(options = {}) {
    const id = options.id ?? DEFAULT_ACCOUNT_ID;
    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      const existing = await scoped.accounts.getById(id);
      if (existing) return existing;
      const startingCash = integer(options.startingCash ?? DEFAULT_STARTING_CASH, "startingCash", { positive: true });
      await transaction.execute(
        `INSERT INTO accounts
          (id, name, mode, starting_cash, cash, realized_pnl, created_at, archived_at)
         VALUES (?, ?, 'paper', ?, ?, 0, ?, NULL)
         ON CONFLICT (id) DO NOTHING`,
        [id, options.name ?? "Stockbot Paper", startingCash, startingCash, options.createdAt ?? clock()]
      );
      return scoped.accounts.getById(id);
    });
  }

  async function getExecution(clientOrderId, expected) {
    const order = await repositories.orders.getByClientOrderId(clientOrderId);
    if (!order) return null;
    if (expected) assertSameOrder(order, expected, integer(expected.qty, "qty", { positive: true }));
    return {
      order,
      fills: await repositories.orders.listFills({ orderId: order.id, limit: 100 }),
      idempotent: true
    };
  }

  async function rejectOrder(input) {
    if (!input?.clientOrderId) throw new TypeError("clientOrderId is required.");
    const qty = integer(input.qty, "qty", { positive: true });
    if (input.side !== "buy" && input.side !== "sell") throw new TypeError("side must be buy or sell.");
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    if (!symbol) throw new TypeError("symbol is required.");
    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      const existing = await scoped.orders.getByClientOrderId(input.clientOrderId);
      if (existing) {
        assertSameOrder(existing, { ...input, symbol }, qty);
        if (existing.status === "pending") {
          const order = await scoped.orders.resolve(existing.id, "rejected", {
            rejectReason: input.rejectReason,
            resolvedAt: input.resolvedAt ?? input.submittedAt ?? clock()
          });
          return { order, fills: [], idempotent: false };
        }
        return { order: existing, fills: await scoped.orders.listFills({ orderId: existing.id }), idempotent: true };
      }
      const at = input.submittedAt ?? clock();
      const orderId = input.id ?? idFactory();
      const order = await scoped.orders.create({
        id: orderId,
        clientOrderId: input.clientOrderId,
        sessionId: input.sessionId ?? null,
        accountId: input.accountId,
        symbol,
        side: input.side,
        qty,
        status: "rejected",
        rejectReason: input.rejectReason,
        signalReason: input.signalReason ?? null,
        signalBarAt: input.signalBarAt ?? null,
        submittedAt: at,
        resolvedAt: at
      });
      if (order.id !== orderId) {
        return { order, fills: await scoped.orders.listFills({ orderId: order.id }), idempotent: true };
      }
      return { order, fills: [], idempotent: false };
    });
  }

  async function createPendingOrder(input) {
    if (!input?.clientOrderId) throw new TypeError("clientOrderId is required.");
    const qty = integer(input.qty, "qty", { positive: true });
    if (input.side !== "buy" && input.side !== "sell") throw new TypeError("side must be buy or sell.");
    const symbol = String(input.symbol ?? "").trim().toUpperCase();
    if (!symbol) throw new TypeError("symbol is required.");

    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      const [rawExisting] = await transaction.query(
        `SELECT * FROM orders WHERE client_order_id = ?${transaction.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        [input.clientOrderId]
      );
      const existing = hydrateRow(rawExisting);
      if (existing) {
        assertSameOrder(existing, { ...input, symbol }, qty);
        return {
          order: existing,
          fills: await scoped.orders.listFills({ orderId: existing.id }),
          idempotent: true
        };
      }
      if (!(await scoped.accounts.getById(input.accountId))) {
        throw executionError("ACCOUNT_NOT_FOUND", `Unknown account: ${input.accountId}`, 404);
      }
      const orderId = input.id ?? idFactory();
      const order = await scoped.orders.create({
        id: orderId,
        clientOrderId: input.clientOrderId,
        sessionId: input.sessionId ?? null,
        accountId: input.accountId,
        symbol,
        side: input.side,
        qty,
        status: "pending",
        signalReason: input.signalReason ?? null,
        signalBarAt: input.signalBarAt ?? null,
        submittedAt: input.submittedAt ?? clock()
      });
      if (order.id !== orderId) assertSameOrder(order, { ...input, symbol }, qty);
      return {
        order,
        fills: await scoped.orders.listFills({ orderId: order.id }),
        idempotent: order.id !== orderId
      };
    });
  }

  async function executeOrder(input) {
    if (!input?.clientOrderId) throw new TypeError("clientOrderId is required.");
    const qty = integer(input.qty, "qty", { positive: true });
    const fillPrice = integer(input.fillPrice, "fillPrice", { positive: true });
    const referencePrice = integer(input.referencePrice, "referencePrice", { positive: true });
    const commission = integer(input.commission ?? 0, "commission", { nonnegative: true });
    const quoteAgeMs = input.quoteAgeMs == null ? null : integer(input.quoteAgeMs, "quoteAgeMs", { nonnegative: true });
    const side = input.side;
    if (side !== "buy" && side !== "sell") throw new TypeError("side must be buy or sell.");

    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      const [rawExisting] = await transaction.query(
        `SELECT * FROM orders WHERE client_order_id = ?${transaction.dialect === "postgres" ? " FOR UPDATE" : ""}`,
        [input.clientOrderId]
      );
      const existing = hydrateRow(rawExisting);
      if (existing) assertSameOrder(existing, input, qty);
      if (existing && existing.status !== "pending") {
        return { order: existing, fills: await scoped.orders.listFills({ orderId: existing.id }), idempotent: true };
      }

      const at = input.submittedAt ?? clock();
      const filledAt = input.filledAt ?? at;
      let orderId = existing?.id;
      if (!orderId) {
        orderId = input.id ?? idFactory();
        const createdOrder = await scoped.orders.create({
          id: orderId,
          clientOrderId: input.clientOrderId,
          sessionId: input.sessionId ?? null,
          accountId: input.accountId,
          symbol: String(input.symbol).toUpperCase(),
          side,
          qty,
          status: "pending",
          signalReason: input.signalReason ?? null,
          signalBarAt: input.signalBarAt ?? null,
          submittedAt: at
        });
        if (createdOrder.id !== orderId) {
          assertSameOrder(createdOrder, input, qty);
          if (createdOrder.status !== "pending") {
            return {
              order: createdOrder,
              fills: await scoped.orders.listFills({ orderId: createdOrder.id }),
              idempotent: true
            };
          }
          orderId = createdOrder.id;
        }
      }

      const account = await scoped.accounts.getById(input.accountId);
      if (!account) throw executionError("ACCOUNT_NOT_FOUND", `Unknown account: ${input.accountId}`, 404);
      const grossNotional = notionalCents(fillPrice, qty);

      if (side === "buy") {
        const debit = grossNotional + commission;
        if (input.sessionId) {
          const available = await sessionCashCents(transaction, input.sessionId, { lock: true });
          if (available < debit) {
            const order = await scoped.orders.resolve(orderId, "rejected", {
              rejectReason: "insufficient_session_funds",
              resolvedAt: filledAt
            });
            return { order, fills: [], idempotent: false };
          }
        }
        const updated = await transaction.execute(
          "UPDATE accounts SET cash = cash - ? WHERE id = ? AND cash >= ?",
          [debit, input.accountId, debit]
        );
        if (updated.changes === 0) {
          const order = await scoped.orders.resolve(orderId, "rejected", {
            rejectReason: "insufficient_funds",
            resolvedAt: filledAt
          });
          return { order, fills: [], idempotent: false };
        }

        const fill = await scoped.orders.addFill({
          id: input.fillId ?? idFactory(),
          orderId,
          qty,
          price: fillPrice,
          referencePrice,
          commission,
          filledAt,
          quoteAgeMs
        });
        const lot = await scoped.orders.createPositionLot({
          id: input.lotId ?? idFactory(),
          sessionId: input.sessionId ?? null,
          accountId: input.accountId,
          symbol: String(input.symbol).toUpperCase(),
          qtyOpen: qty,
          qtyOriginal: qty,
          entryPrice: fillPrice,
          entryOrderId: orderId,
          openedAt: filledAt
        });
        const order = await scoped.orders.resolve(orderId, "filled", { resolvedAt: filledAt });
        return { order, fills: [fill], lot, continued: Boolean(existing), idempotent: false };
      }

      const sessionFilter = input.sessionId ? " AND session_id = ?" : "";
      const lotParams = [input.accountId, String(input.symbol).toUpperCase()];
      if (input.sessionId) lotParams.push(input.sessionId);
      const lots = (
        await transaction.query(
          `SELECT * FROM position_lots
           WHERE account_id = ? AND symbol = ?${sessionFilter} AND closed_at IS NULL AND qty_open > 0
           ORDER BY opened_at, id${transaction.dialect === "postgres" ? " FOR UPDATE" : ""}`,
          lotParams
        )
      ).map(hydrateRow);
      const available = sumIntegers(lots.map((lot) => lot.qtyOpen), "available quantity");
      if (available < qty) {
        const order = await scoped.orders.resolve(orderId, "rejected", {
          rejectReason: "insufficient_position",
          resolvedAt: filledAt
        });
        return { order, fills: [], idempotent: false };
      }
      if (grossNotional < commission) {
        throw executionError("INVALID_COMMISSION", "Commission cannot exceed sell proceeds.");
      }

      const fill = await scoped.orders.addFill({
        id: input.fillId ?? idFactory(),
        orderId,
        qty,
        price: fillPrice,
        referencePrice,
        commission,
        filledAt,
        quoteAgeMs
      });

      let remaining = qty;
      let consumed = 0;
      let realizedPnl = 0;
      const closedLots = [];
      for (const lot of lots) {
        if (remaining === 0) break;
        const consumedFromLot = Math.min(remaining, Number(lot.qtyOpen));
        const alreadyConsumed = Number(lot.qtyOriginal) - Number(lot.qtyOpen);
        const [entryCommissionRow] = await transaction.query(
          "SELECT COALESCE(SUM(commission), 0) AS commission FROM fills WHERE order_id = ?",
          [lot.entryOrderId]
        );
        const entryCommission = Number(entryCommissionRow?.commission ?? 0);
        const entryBefore = allocateProportion(entryCommission, alreadyConsumed, Number(lot.qtyOriginal));
        const entryThrough = allocateProportion(
          entryCommission,
          alreadyConsumed + consumedFromLot,
          Number(lot.qtyOriginal)
        );
        const exitBefore = allocateProportion(commission, consumed, qty);
        const exitThrough = allocateProportion(commission, consumed + consumedFromLot, qty);
        const pricePnl = signedNotionalCents(fillPrice - Number(lot.entryPrice), consumedFromLot);
        const lotPnl = pricePnl - (entryThrough - entryBefore) - (exitThrough - exitBefore);
        const nextQty = Number(lot.qtyOpen) - consumedFromLot;
        const cumulativePnl = Number(lot.realizedPnl ?? 0) + lotPnl;
        const lotUpdate = await transaction.execute(
          `UPDATE position_lots SET
             qty_open = ?, exit_price = ?, exit_order_id = ?, realized_pnl = ?, closed_at = ?
           WHERE id = ? AND closed_at IS NULL AND qty_open = ?`,
          [nextQty, fillPrice, orderId, cumulativePnl, nextQty === 0 ? filledAt : null, lot.id, lot.qtyOpen]
        );
        if (lotUpdate.changes !== 1) {
          throw executionError("POSITION_CHANGED", "Position changed during FIFO allocation.", 409, {
            lotId: lot.id
          });
        }
        realizedPnl += lotPnl;
        closedLots.push({ lotId: lot.id, qty: consumedFromLot, realizedPnl: lotPnl, remainingQty: nextQty });
        remaining -= consumedFromLot;
        consumed += consumedFromLot;
      }

      await transaction.execute(
        "UPDATE accounts SET cash = cash + ?, realized_pnl = realized_pnl + ? WHERE id = ?",
        [grossNotional - commission, realizedPnl, input.accountId]
      );
      const order = await scoped.orders.resolve(orderId, "filled", { resolvedAt: filledAt });
      return { order, fills: [fill], closedLots, realizedPnl, continued: Boolean(existing), idempotent: false };
    });
  }

  async function listOpenPositions(accountId, options = {}) {
    const lots = await repositories.orders.listOpenLots(accountId, { sessionId: options.sessionId, limit: 2_000 });
    const grouped = new Map();
    for (const lot of lots) {
      const position = grouped.get(lot.symbol) ?? { symbol: lot.symbol, qty: 0, lots: [] };
      position.qty += Number(lot.qtyOpen);
      position.lots.push(lot);
      grouped.set(lot.symbol, position);
    }
    return Array.from(grouped.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  async function countOrders(accountId, after) {
    const [row] = await client.query(
      "SELECT COUNT(*) AS count FROM orders WHERE account_id = ? AND submitted_at >= ?",
      [accountId, after]
    );
    return Number(row?.count ?? 0);
  }

  async function latestReferencePrice(accountId, symbol) {
    const [row] = await client.query(
      `SELECT fills.reference_price
       FROM fills JOIN orders ON orders.id = fills.order_id
       WHERE orders.account_id = ? AND orders.symbol = ?
       ORDER BY fills.filled_at DESC, fills.id DESC LIMIT 1`,
      [accountId, String(symbol).toUpperCase()]
    );
    return row ? Number(row.reference_price) : null;
  }

  async function portfolio(accountId, { quotes = new Map(), at = clock(), sessionId = null } = {}) {
    const account = await repositories.accounts.getById(accountId);
    if (!account) throw executionError("ACCOUNT_NOT_FOUND", `Unknown account: ${accountId}`, 404);
    const open = await listOpenPositions(accountId, { sessionId });
    let allReal = true;
    let positionValue = 0;
    const positions = open.map((position) => {
      const quantity = position.qty;
      const entryNumerator = position.lots.reduce(
        (sum, lot) => sum + BigInt(lot.entryPrice) * BigInt(lot.qtyOpen),
        0n
      );
      const averagePrice = safeNumber(roundedDivision(entryNumerator, BigInt(quantity)), "average price");
      const costBasis = sumIntegers(
        position.lots.map((lot) => notionalCents(Number(lot.entryPrice), Number(lot.qtyOpen))),
        "cost basis"
      );
      const quote = quotes instanceof Map ? quotes.get(position.symbol) : quotes[position.symbol];
      const real = quote?.status === "real" && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0;
      if (!real) {
        allReal = false;
        return {
          symbol: position.symbol,
          qty: quantity,
          avgPrice: averagePrice,
          price: null,
          marketValue: null,
          unrealizedPnl: null,
          unrealizedPnlPercent: null,
          dataStatus: "unavailable",
          dataError: quote?.error ?? "Real quote unavailable."
        };
      }
      const price = dollarsToCents(quote.price);
      const marketValue = notionalCents(price, quantity);
      const unrealizedPnl = marketValue - costBasis;
      positionValue += marketValue;
      return {
        symbol: position.symbol,
        qty: quantity,
        avgPrice: averagePrice,
        price,
        marketValue,
        unrealizedPnl,
        unrealizedPnlPercent: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : null,
        dataStatus: "real",
        dataSource: quote.source,
        quoteAt: quote.at,
        quoteAgeMs: Math.max(0, at - quote.at)
      };
    });
    const cash = sessionId ? await sessionCashCents(client, sessionId) : Number(account.cash);
    const equity = allReal ? cash + positionValue : null;
    const allCrypto = open.length > 0 && open.every((position) => isCryptoSymbol(position.symbol));
    const priorCutoff = startOfDay(at, allCrypto ? "UTC" : "America/New_York");
    const scopeClause = sessionId ? "sessions.id = ?" : "sessions.account_id = ?";
    const [prior] = await client.query(
      `SELECT equity_snapshots.equity, equity_snapshots.at
       FROM equity_snapshots
       JOIN sessions ON sessions.id = equity_snapshots.session_id
       WHERE ${scopeClause} AND equity_snapshots.at < ?
       ORDER BY equity_snapshots.at DESC LIMIT 1`,
      [sessionId ?? accountId, priorCutoff]
    );
    const [firstToday] = await client.query(
      `SELECT equity_snapshots.equity, equity_snapshots.at
       FROM equity_snapshots
       JOIN sessions ON sessions.id = equity_snapshots.session_id
       WHERE ${scopeClause} AND equity_snapshots.at >= ? AND equity_snapshots.at < ?
       ORDER BY equity_snapshots.at, equity_snapshots.session_id LIMIT 1`,
      [sessionId ?? accountId, priorCutoff, at]
    );
    const [realizedRow] = sessionId
      ? await client.query(
          "SELECT COALESCE(SUM(realized_pnl), 0) AS realized_pnl FROM position_lots WHERE session_id = ?",
          [sessionId]
        )
      : [{ realized_pnl: account.realizedPnl }];
    const orders = await repositories.orders.list({ accountId, sessionId: sessionId ?? undefined, limit: 50 });
    const dayStartEquity = equity === null ? null : Number(prior?.equity ?? firstToday?.equity ?? equity);
    return {
      accountId,
      sessionId,
      cash,
      accountCash: Number(account.cash),
      buyingPower: Math.min(cash, Number(account.cash)),
      equity,
      dayChange: equity !== null && prior ? equity - Number(prior.equity) : null,
      dayStartEquity,
      realizedPnl: Number(realizedRow?.realized_pnl ?? 0),
      positionValue: allReal ? positionValue : null,
      positions,
      orders,
      dataStatus: allReal ? "real" : "unavailable",
      at
    };
  }

  async function persistBacktestResult(input) {
    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      for (const snapshot of input.equity ?? []) await scoped.sessions.addEquitySnapshot(snapshot);
      for (const execution of input.executions ?? []) {
        const order = await scoped.orders.create(execution.order);
        if (execution.fill) await scoped.orders.addFill({ ...execution.fill, orderId: order.id });
      }
      const metrics = input.metrics ? await scoped.sessions.upsertMetrics(input.metrics) : null;
      const session = input.complete
        ? await scoped.sessions.transition(input.sessionId, input.complete.status ?? "stopped", input.complete.options)
        : await scoped.sessions.getById(input.sessionId);
      return { session, metrics };
    });
  }

  return Object.freeze({
    ensureDefaultAccount,
    createPendingOrder,
    executeOrder,
    rejectOrder,
    getExecution,
    listOpenPositions,
    countOrders,
    latestReferencePrice,
    portfolio,
    persistBacktestResult
  });
}
