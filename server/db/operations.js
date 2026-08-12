import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createLedger, DEFAULT_ACCOUNT_ID, DEFAULT_STARTING_CASH } from "../broker/ledger.js";
import { createClient } from "./client.js";
import { migrate, readMigrations } from "./migrate.js";
import { createRepositories } from "./repositories/index.js";

const SQLITE_OK = "ok";
const DEFAULT_LEDGER_LIMIT = 10_000;
const MAX_LEDGER_LIMIT = 100_000;

function operationError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function boundedLimit(value) {
  const parsed = Number(value ?? DEFAULT_LEDGER_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LEDGER_LIMIT) {
    throw operationError(`limit must be an integer from 1 to ${MAX_LEDGER_LIMIT}.`, "ERR_LEDGER_LIMIT");
  }
  return parsed;
}

function safeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw operationError(`${label} exceeds JavaScript's safe integer range.`, "ERR_LEDGER_INTEGER");
  }
  return parsed;
}

function notionalCents(price, quantity) {
  const numerator = BigInt(price) * BigInt(quantity);
  const rounded = (numerator + 500_000n) / 1_000_000n;
  return safeInteger(rounded, "Trade notional");
}

function filterClause(options, alias = "orders") {
  const clauses = [];
  const params = [];
  if (options.accountId) {
    clauses.push(`${alias}.account_id = ?`);
    params.push(options.accountId);
  }
  if (options.sessionId) {
    clauses.push(`${alias}.session_id = ?`);
    params.push(options.sessionId);
  }
  if (options.since !== undefined) {
    clauses.push(`${alias}.submitted_at >= ?`);
    params.push(options.since);
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function scopedWhere(options, { timeColumn = "at", supportsAccount = true, supportsSession = true } = {}) {
  const clauses = [];
  const params = [];
  if (supportsAccount && options.accountId) {
    clauses.push("account_id = ?");
    params.push(options.accountId);
  }
  if (supportsSession && options.sessionId) {
    clauses.push("session_id = ?");
    params.push(options.sessionId);
  }
  if (options.since !== undefined) {
    clauses.push(`${timeColumn} >= ?`);
    params.push(options.since);
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

async function appliedMigrations(client) {
  try {
    return await client.query("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version");
  } catch {
    return [];
  }
}

async function invariantCounts(client) {
  const queries = {
    negativeAccountCash: "SELECT COUNT(*) AS count FROM accounts WHERE cash < 0",
    invalidLotQuantity:
      "SELECT COUNT(*) AS count FROM position_lots WHERE qty_open < 0 OR qty_original <= 0 OR qty_open > qty_original",
    overfilledOrders: `SELECT COUNT(*) AS count FROM (
      SELECT orders.id FROM orders
      JOIN fills ON fills.order_id = orders.id
      GROUP BY orders.id, orders.qty HAVING SUM(fills.qty) > orders.qty
    ) AS invalid_orders`,
    filledWithoutFill: `SELECT COUNT(*) AS count FROM orders
      WHERE status = 'filled' AND NOT EXISTS (SELECT 1 FROM fills WHERE fills.order_id = orders.id)`,
    openLotWithoutEntryFill: `SELECT COUNT(*) AS count FROM position_lots
      WHERE closed_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM fills WHERE fills.order_id = position_lots.entry_order_id
      )`
  };
  const result = {};
  for (const [name, sql] of Object.entries(queries)) {
    const [row] = await client.query(sql);
    result[name] = Number(row?.count ?? 0);
  }
  return result;
}

async function tableCounts(client) {
  const result = {};
  for (const table of [
    "accounts",
    "sessions",
    "orders",
    "fills",
    "position_lots",
    "equity_snapshots",
    "risk_events",
    "audit_log"
  ]) {
    const [row] = await client.query(`SELECT COUNT(*) AS count FROM ${table}`);
    result[table] = Number(row?.count ?? 0);
  }
  return result;
}

/** Read-only database readiness and ledger-consistency report. */
export async function databaseStatus(client, options = {}) {
  if (!client?.query) throw new TypeError("databaseStatus requires a database client.");
  const expected = await readMigrations(options.migrationsDirectory);
  const applied = await appliedMigrations(client);
  const appliedByVersion = new Map(applied.map((entry) => [entry.version, entry]));
  const pending = expected.filter((entry) => !appliedByVersion.has(entry.version)).map((entry) => entry.version);
  const drifted = expected
    .filter((entry) => appliedByVersion.has(entry.version) && appliedByVersion.get(entry.version).checksum !== entry.checksum)
    .map((entry) => entry.version);

  if (pending.length || drifted.length) {
    return {
      healthy: false,
      dialect: client.dialect,
      schema: { current: false, expected: expected.map((entry) => entry.version), applied, pending, drifted },
      counts: null,
      invariants: null
    };
  }

  const invariants = await invariantCounts(client);
  const violations = Object.values(invariants).reduce((sum, value) => sum + value, 0);
  const sqlite = client.dialect === "sqlite"
    ? {
        journalMode: String((await client.query("PRAGMA journal_mode"))[0]?.journal_mode ?? "").toLowerCase(),
        synchronous: Number((await client.query("PRAGMA synchronous"))[0]?.synchronous),
        foreignKeys: Number((await client.query("PRAGMA foreign_keys"))[0]?.foreign_keys) === 1,
        integrity: String((await client.query("PRAGMA quick_check"))[0]?.quick_check ?? "")
      }
    : null;
  const sqliteHealthy = !sqlite || (
    sqlite.journalMode === "wal" && sqlite.synchronous === 2 && sqlite.foreignKeys && sqlite.integrity === SQLITE_OK
  );
  return {
    healthy: violations === 0 && sqliteHealthy,
    dialect: client.dialect,
    schema: { current: true, expected: expected.map((entry) => entry.version), applied, pending: [], drifted: [] },
    counts: await tableCounts(client),
    invariants,
    sqlite
  };
}

/** Applies migrations and creates the idempotent default paper account. */
export async function initializeDatabase(client, options = {}) {
  const migrationResult = await migrate(client, options);
  const repositories = createRepositories(client);
  const account = await createLedger({ client, repositories }).ensureDefaultAccount({
    id: options.accountId ?? DEFAULT_ACCOUNT_ID,
    name: options.accountName ?? "Stockbot Paper",
    startingCash: options.startingCash ?? DEFAULT_STARTING_CASH,
    createdAt: options.now?.() ?? Date.now()
  });
  return { migrations: migrationResult, account, status: await databaseStatus(client, options) };
}

function auditFilter(options, orderIds) {
  const clauses = [];
  const params = [];
  if (options.since !== undefined) {
    clauses.push("at >= ?");
    params.push(options.since);
  }
  const entityIds = [...new Set([options.sessionId, ...orderIds].filter(Boolean))];
  if (entityIds.length) {
    clauses.push(`entity_id IN (${entityIds.map(() => "?").join(", ")})`);
    params.push(...entityIds);
  } else if (options.accountId) {
    // Audit rows deliberately do not duplicate account_id. Restrict account
    // reports to the order IDs selected by the account query.
    clauses.push("1 = 0");
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Returns a persisted execution ledger and reconciliation summary. */
export async function tradeLedger(client, options = {}) {
  if (!client?.query) throw new TypeError("tradeLedger requires a database client.");
  const limit = boundedLimit(options.limit);
  const ordersFilter = filterClause(options);
  const executionRows = await client.query(
    `SELECT
       orders.id AS order_id, orders.client_order_id, orders.session_id, orders.account_id,
       sessions.name AS session_name, sessions.mode AS session_mode,
       orders.symbol, orders.side, orders.order_type, orders.qty AS order_qty,
       orders.status AS order_status, orders.reject_reason, orders.signal_reason,
       orders.signal_bar_at, orders.submitted_at, orders.resolved_at,
       fills.id AS fill_id, fills.qty AS fill_qty, fills.price AS fill_price,
       fills.reference_price, fills.commission, fills.filled_at, fills.quote_age_ms
     FROM orders
     LEFT JOIN sessions ON sessions.id = orders.session_id
     LEFT JOIN fills ON fills.order_id = orders.id
     ${ordersFilter.clause}
     ORDER BY orders.submitted_at, orders.id, fills.filled_at, fills.id
     LIMIT ?`,
    [...ordersFilter.params, limit]
  );
  const orderIds = [...new Set(executionRows.map((row) => row.order_id))];

  const lotsScope = scopedWhere(options, { timeColumn: "opened_at" });
  const lots = await client.query(
    `SELECT * FROM position_lots ${lotsScope.clause} ORDER BY opened_at, id LIMIT ?`,
    [...lotsScope.params, limit]
  );
  const riskScope = scopedWhere(options);
  const riskEvents = await client.query(
    `SELECT * FROM risk_events ${riskScope.clause} ORDER BY at, id LIMIT ?`,
    [...riskScope.params, limit]
  );

  const equityClauses = [];
  const equityParams = [];
  if (options.accountId) {
    equityClauses.push("sessions.account_id = ?");
    equityParams.push(options.accountId);
  }
  if (options.sessionId) {
    equityClauses.push("equity_snapshots.session_id = ?");
    equityParams.push(options.sessionId);
  }
  if (options.since !== undefined) {
    equityClauses.push("equity_snapshots.at >= ?");
    equityParams.push(options.since);
  }
  const equityWhere = equityClauses.length ? `WHERE ${equityClauses.join(" AND ")}` : "";
  const [latestEquity] = await client.query(
    `SELECT equity_snapshots.* FROM equity_snapshots
     JOIN sessions ON sessions.id = equity_snapshots.session_id
     ${equityWhere}
     ORDER BY equity_snapshots.at DESC, equity_snapshots.session_id DESC LIMIT 1`,
    equityParams
  );

  const auditScope = auditFilter(options, orderIds);
  const auditEvents = await client.query(
    `SELECT * FROM audit_log ${auditScope.clause} ORDER BY at, id LIMIT ?`,
    [...auditScope.params, limit]
  );

  const fills = executionRows.filter((row) => row.fill_id != null);
  const uniqueOrders = new Map(executionRows.map((row) => [row.order_id, row]));
  const grossBuyCents = fills
    .filter((row) => row.side === "buy")
    .reduce((sum, row) => sum + notionalCents(row.fill_price, row.fill_qty), 0);
  const grossSellCents = fills
    .filter((row) => row.side === "sell")
    .reduce((sum, row) => sum + notionalCents(row.fill_price, row.fill_qty), 0);
  const realizedPnlCents = lots.reduce((sum, lot) => sum + Number(lot.realized_pnl ?? 0), 0);
  const commissionsCents = fills.reduce((sum, row) => sum + Number(row.commission ?? 0), 0);
  const byStatus = {};
  for (const order of uniqueOrders.values()) byStatus[order.order_status] = (byStatus[order.order_status] ?? 0) + 1;

  return {
    filters: {
      accountId: options.accountId ?? null,
      sessionId: options.sessionId ?? null,
      since: options.since ?? null
    },
    summary: {
      orders: uniqueOrders.size,
      fills: fills.length,
      byStatus,
      grossBuyCents,
      grossSellCents,
      commissionsCents,
      realizedPnlCents,
      openLots: lots.filter((lot) => lot.closed_at == null).length,
      riskEvents: riskEvents.length,
      auditEvents: auditEvents.length,
      latestEquityCents: latestEquity?.equity ?? null,
      latestEquityAt: latestEquity?.at ?? null
    },
    executions: executionRows.map((row) => ({
      ...row,
      notional_cents: row.fill_id == null ? null : notionalCents(row.fill_price, row.fill_qty)
    })),
    lots,
    riskEvents,
    auditEvents,
    latestEquity: latestEquity ?? null
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tradeLedgerCsv(report) {
  const fields = [
    "order_id", "client_order_id", "session_id", "account_id", "session_name", "session_mode",
    "symbol", "side", "order_type", "order_qty", "order_status", "reject_reason", "signal_reason",
    "signal_bar_at", "submitted_at", "resolved_at", "fill_id", "fill_qty", "fill_price",
    "reference_price", "commission", "notional_cents", "filled_at", "quote_age_ms"
  ];
  const lines = [fields.join(",")];
  for (const execution of report.executions) {
    lines.push(fields.map((field) => csvCell(execution[field])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates and verifies a consistent SQLite backup without copying a live DB file. */
export async function backupSqliteDatabase(client, destination, options = {}) {
  if (client?.dialect !== "sqlite" || typeof client.backup !== "function") {
    throw operationError(
      "Online backup is available only for SQLite. For PostgreSQL, use pg_dump with your private DATABASE_URL.",
      "ERR_POSTGRES_BACKUP_UNSUPPORTED"
    );
  }
  if (!client.path || client.path === ":memory:") {
    throw operationError("SQLite backup requires a file-backed database.", "ERR_SQLITE_BACKUP_MEMORY");
  }
  const target = resolve(String(destination ?? ""));
  if (!destination) throw operationError("A backup output path is required.", "ERR_BACKUP_DESTINATION");
  if (target === resolve(client.path)) {
    throw operationError("Backup destination must differ from the live database.", "ERR_BACKUP_SAME_FILE");
  }
  if (await exists(target)) {
    throw operationError("Backup destination already exists; choose a new path.", "ERR_BACKUP_EXISTS");
  }

  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${options.idFactory?.() ?? randomUUID()}`;
  const temporaryArtifacts = [temporary, `${temporary}-wal`, `${temporary}-shm`];
  let verification;
  try {
    const pages = await client.backup(temporary, { rate: options.rate ?? 100 });
    const verifier = await createClient(pathToFileURL(temporary).href);
    try {
      const integrity = String((await verifier.query("PRAGMA integrity_check"))[0]?.integrity_check ?? "");
      const foreignKeyViolations = await verifier.query("PRAGMA foreign_key_check");
      const sourceMigrations = await appliedMigrations(client);
      const backupMigrations = await appliedMigrations(verifier);
      if (integrity !== SQLITE_OK || foreignKeyViolations.length > 0) {
        throw operationError("SQLite backup failed integrity validation.", "ERR_BACKUP_INTEGRITY");
      }
      if (JSON.stringify(sourceMigrations) !== JSON.stringify(backupMigrations)) {
        throw operationError("SQLite backup migration state differs from the source.", "ERR_BACKUP_SCHEMA_STATE");
      }
      verification = { integrity, foreignKeyViolations: 0, migrations: backupMigrations };
    } finally {
      await verifier.close();
    }
    // Opening the verification client enables WAL on file databases. Its
    // sidecars should normally disappear on close, but remove any empty
    // remnants so a successful backup publishes exactly one portable file.
    await rm(`${temporary}-wal`, { force: true });
    await rm(`${temporary}-shm`, { force: true });
    await rename(temporary, target);
    return { path: target, pages, verification };
  } catch (error) {
    for (const artifact of temporaryArtifacts) await rm(artifact, { force: true });
    throw error;
  }
}
