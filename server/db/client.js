import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const POSTGRES_INT8_OID = 20;

function databaseError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function normalizeInteger(value) {
  if (typeof value !== "bigint") {
    return value;
  }
  if (value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT) {
    return Number(value);
  }
  return value.toString();
}

function normalizeSqliteRow(row) {
  if (!row) {
    return row;
  }
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeInteger(value)]));
}

function normalizePostgresRows(result) {
  const int8Fields = new Set(
    (result.fields ?? []).filter((field) => field.dataTypeID === POSTGRES_INT8_OID).map((field) => field.name)
  );
  return (result.rows ?? []).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (!int8Fields.has(key) || typeof value !== "string" || !/^-?\d+$/.test(value)) {
          return [key, value];
        }
        return [key, normalizeInteger(BigInt(value))];
      })
    )
  );
}

function normalizePostgresParams(params) {
  return params.map((value) => (typeof value === "bigint" ? value.toString() : value));
}

function assertParams(params) {
  if (!Array.isArray(params)) {
    throw new TypeError("SQL parameters must be an array.");
  }
}

function dollarQuoteAt(sql, offset) {
  const match = sql.slice(offset).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
  return match?.[0] ?? null;
}

/**
 * Rewrites portable `?` parameters to PostgreSQL `$1` parameters while
 * preserving question marks inside strings, identifiers, comments, and
 * dollar-quoted function bodies.
 */
export function rewritePlaceholders(sql) {
  if (typeof sql !== "string") {
    throw new TypeError("SQL must be a string.");
  }

  let output = "";
  let parameter = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      output += character;
      index += 1;
      while (index < sql.length) {
        const current = sql[index];
        output += current;
        index += 1;
        if (current === "\\" && index < sql.length) {
          output += sql[index];
          index += 1;
          continue;
        }
        if (current === quote) {
          if (sql[index] === quote) {
            output += sql[index];
            index += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (character === "[") {
      const end = sql.indexOf("]", index + 1);
      if (end === -1) {
        output += sql.slice(index);
        break;
      }
      output += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      if (end === -1) {
        output += sql.slice(index);
        break;
      }
      output += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }

    if (character === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql[cursor] === "/" && sql[cursor + 1] === "*") {
          depth += 1;
          cursor += 2;
        } else if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      output += sql.slice(index, cursor);
      index = cursor;
      continue;
    }

    if (character === "$") {
      const delimiter = dollarQuoteAt(sql, index);
      if (delimiter) {
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end === -1) {
          output += sql.slice(index);
          break;
        }
        const after = end + delimiter.length;
        output += sql.slice(index, after);
        index = after;
        continue;
      }
    }

    if (character === "?") {
      parameter += 1;
      output += `$${parameter}`;
      index += 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

export function sqlitePathFromUrl(databaseUrl, cwd = process.cwd()) {
  const value = String(databaseUrl ?? "").trim();
  if (value === ":memory:" || value === "file::memory:") {
    return ":memory:";
  }
  if (!value.startsWith("file:")) {
    throw databaseError(`Unsupported SQLite URL: ${value || "<empty>"}`, "ERR_DATABASE_URL");
  }

  if (value.startsWith("file://")) {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return fileURLToPath(url);
  }

  const rawPath = value.slice("file:".length).split(/[?#]/, 1)[0];
  if (!rawPath) {
    throw databaseError("A file: database URL must include a path.", "ERR_DATABASE_URL");
  }
  return resolve(cwd, decodeURIComponent(rawPath));
}

function createQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };
}

async function createSqliteClient(databaseUrl, options = {}) {
  const filename = sqlitePathFromUrl(databaseUrl, options.cwd);
  if (filename !== ":memory:") {
    await mkdir(dirname(filename), { recursive: true });
  }

  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON");
  if (filename !== ":memory:") {
    const journalMode = database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (String(journalMode).toLowerCase() !== "wal") {
      database.close();
      throw databaseError("SQLite could not enable WAL journal mode.", "ERR_SQLITE_WAL");
    }
  }
  // FULL is intentionally more conservative than SQLite's WAL default. The
  // laptop process is a trading ledger, so acknowledged commits must survive a
  // power loss even if that costs a little write throughput.
  database.exec("PRAGMA synchronous = FULL");
  const busyTimeout = Number(options.busyTimeoutMs ?? 5_000);
  if (Number.isFinite(busyTimeout) && busyTimeout >= 0) {
    database.exec(`PRAGMA busy_timeout = ${Math.floor(busyTimeout)}`);
  }

  const enqueue = createQueue();
  let closed = false;
  let savepointSequence = 0;

  function assertOpen() {
    if (closed) {
      throw databaseError("Database client is closed.", "ERR_DATABASE_CLOSED");
    }
  }

  function prepare(sql) {
    assertOpen();
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return statement;
  }

  async function directQuery(sql, params = []) {
    assertParams(params);
    return prepare(sql).all(...params).map(normalizeSqliteRow);
  }

  async function directExecute(sql, params = []) {
    assertParams(params);
    const result = prepare(sql).run(...params);
    return {
      changes: normalizeInteger(result.changes),
      lastInsertRowid: normalizeInteger(result.lastInsertRowid)
    };
  }

  async function directExec(sql) {
    assertOpen();
    database.exec(sql);
  }

  function transactionScope() {
    const scope = {
      dialect: "sqlite",
      path: filename,
      query: directQuery,
      execute: directExecute,
      exec: directExec,
      transaction: async (callback) => {
        if (typeof callback !== "function") {
          throw new TypeError("transaction(callback) requires a function.");
        }
        const savepoint = `stockbot_sp_${++savepointSequence}`;
        database.exec(`SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(scope);
          database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          database.exec(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
    };
    return Object.freeze(scope);
  }

  const client = {
    dialect: "sqlite",
    path: filename,
    query: (sql, params = []) => enqueue(() => directQuery(sql, params)),
    execute: (sql, params = []) => enqueue(() => directExecute(sql, params)),
    exec: (sql) => enqueue(() => directExec(sql)),
    transaction: (callback) => {
      if (typeof callback !== "function") {
        return Promise.reject(new TypeError("transaction(callback) requires a function."));
      }
      return enqueue(async () => {
        assertOpen();
        database.exec("BEGIN IMMEDIATE");
        try {
          const result = await callback(transactionScope());
          database.exec("COMMIT");
          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
    },
    backup: (destination, backupOptions = {}) =>
      enqueue(async () => {
        assertOpen();
        if (filename === ":memory:") {
          throw databaseError("SQLite backups require a file-backed database.", "ERR_SQLITE_BACKUP_MEMORY");
        }
        return sqliteBackup(database, destination, backupOptions);
      }),
    close: () =>
      enqueue(async () => {
        if (!closed) {
          database.close();
          closed = true;
        }
      })
  };

  return Object.freeze(client);
}

async function loadPostgresPool() {
  try {
    const module = await import("pg");
    return module.Pool ?? module.default?.Pool;
  } catch (cause) {
    throw databaseError(
      "PostgreSQL URLs require the optional `pg` package. Install it before using DATABASE_URL=postgres://…",
      "ERR_PG_DRIVER_MISSING",
      cause
    );
  }
}

async function createPostgresClient(databaseUrl, options = {}) {
  const Pool = options.Pool ?? (await loadPostgresPool());
  if (typeof Pool !== "function") {
    throw databaseError("The loaded PostgreSQL driver does not expose Pool.", "ERR_PG_DRIVER_INVALID");
  }

  const pool = options.pool ?? new Pool({
    connectionString: databaseUrl,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000
  });
  let closed = false;
  let savepointSequence = 0;

  function assertOpen() {
    if (closed) {
      throw databaseError("Database client is closed.", "ERR_DATABASE_CLOSED");
    }
  }

  async function queryWith(executor, sql, params = []) {
    assertOpen();
    assertParams(params);
    const result = await executor.query(rewritePlaceholders(sql), normalizePostgresParams(params));
    return normalizePostgresRows(result);
  }

  async function executeWith(executor, sql, params = []) {
    assertOpen();
    assertParams(params);
    const result = await executor.query(rewritePlaceholders(sql), normalizePostgresParams(params));
    return {
      changes: result.rowCount ?? 0,
      rows: normalizePostgresRows(result)
    };
  }

  async function execWith(executor, sql) {
    assertOpen();
    await executor.query(sql);
  }

  function transactionScope(connection) {
    const scope = {
      dialect: "postgres",
      query: (sql, params = []) => queryWith(connection, sql, params),
      execute: (sql, params = []) => executeWith(connection, sql, params),
      exec: (sql) => execWith(connection, sql),
      transaction: async (callback) => {
        if (typeof callback !== "function") {
          throw new TypeError("transaction(callback) requires a function.");
        }
        const savepoint = `stockbot_sp_${++savepointSequence}`;
        await connection.query(`SAVEPOINT ${savepoint}`);
        try {
          const result = await callback(scope);
          await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await connection.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }
    };
    return Object.freeze(scope);
  }

  const client = {
    dialect: "postgres",
    query: (sql, params = []) => queryWith(pool, sql, params),
    execute: (sql, params = []) => executeWith(pool, sql, params),
    exec: (sql) => execWith(pool, sql),
    transaction: async (callback) => {
      if (typeof callback !== "function") {
        throw new TypeError("transaction(callback) requires a function.");
      }
      assertOpen();
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const result = await callback(transactionScope(connection));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await connection.query("ROLLBACK");
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      } finally {
        connection.release();
      }
    },
    close: async () => {
      if (!closed) {
        await pool.end();
        closed = true;
      }
    }
  };

  return Object.freeze(client);
}

/**
 * Creates a database client with one async API for SQLite and PostgreSQL.
 * SQLite URLs use `file:...`; PostgreSQL URLs use `postgres://` or
 * `postgresql://` and load `pg` only when selected.
 */
export async function createClient(databaseUrl, options = {}) {
  const value = String(databaseUrl ?? "").trim();
  if (/^postgres(?:ql)?:\/\//i.test(value)) {
    return createPostgresClient(value, options);
  }
  if (value === ":memory:" || value.startsWith("file:")) {
    return createSqliteClient(value, options);
  }
  throw databaseError(
    "DATABASE_URL must be a file: SQLite URL or a postgres:// PostgreSQL URL.",
    "ERR_DATABASE_URL"
  );
}
