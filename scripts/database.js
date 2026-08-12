#!/usr/bin/env node
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseEnv } from "dotenv";

import { createClient, sqlitePathFromUrl } from "../server/db/client.js";
import {
  backupSqliteDatabase,
  databaseStatus,
  initializeDatabase,
  tradeLedger,
  tradeLedgerCsv
} from "../server/db/operations.js";

function cliError(message, code = "ERR_DATABASE_CLI", detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function parseArguments(argv) {
  const [command, ...values] = argv;
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw cliError(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    if (rawName === "help") {
      options.help = true;
      continue;
    }
    const value = inline ?? values[++index];
    if (value == null || value.startsWith("--")) throw cliError(`--${rawName} requires a value.`);
    options[rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

function databaseUrl(environment) {
  const value = String(environment.DATABASE_URL ?? "").trim();
  if (!value) {
    throw cliError("DATABASE_URL must be set in the private environment or .env file.", "ERR_DATABASE_URL_REQUIRED");
  }
  return value;
}

async function environmentWithFile(environment, filename) {
  if (!filename) return environment;
  const path = resolve(filename);
  let metadata;
  try {
    metadata = await stat(path);
  } catch (cause) {
    throw cliError("The requested environment file cannot be read.", "ERR_ENV_FILE_NOT_FOUND", { cause });
  }
  if (!metadata.isFile()) throw cliError("--env-file must identify a regular file.", "ERR_ENV_FILE_INVALID");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw cliError("The environment file must have owner-only permissions (chmod 600).", "ERR_ENV_FILE_PERMISSIONS");
  }
  let parsed;
  try {
    parsed = parseEnv(await readFile(path, "utf8"));
  } catch (cause) {
    throw cliError("The requested environment file cannot be parsed.", "ERR_ENV_FILE_INVALID", { cause });
  }
  // Explicit environment variables always win; loading a file never mutates
  // process.env and therefore cannot leak configuration into later operations.
  return { ...parsed, ...environment };
}

async function environmentWithDefaultFile(environment) {
  try {
    return { ...parseEnv(await readFile(resolve(".env"), "utf8")), ...environment };
  } catch (error) {
    if (error?.code === "ENOENT") return environment;
    throw cliError("The project .env file cannot be read.", "ERR_ENV_FILE_INVALID", { cause: error });
  }
}

function since(value) {
  if (value == null) return undefined;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value);
    if (Number.isSafeInteger(milliseconds)) return milliseconds;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw cliError("--since must be UTC epoch milliseconds or an ISO-8601 timestamp.", "ERR_SINCE");
  }
  return milliseconds;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function output(text, destination, stdout) {
  if (!destination || destination === "-") {
    stdout.write(text);
    return null;
  }
  const path = resolve(destination);
  if (await fileExists(path)) throw cliError("Output file already exists; choose a new path.", "ERR_OUTPUT_EXISTS");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", flag: "wx" });
  return path;
}

function usage() {
  return `Stockbot database operations

Usage:
  npm run db:init [-- --env-file /private/path/stockbot.env]
  npm run db:status [-- --env-file /private/path/stockbot.env]
  npm run db:backup -- --output /path/to/stockbot-YYYY-MM-DD.db
  npm run db:trades -- [--account ID] [--session ID] [--since TIME]
                       [--format json|csv] [--output PATH|-] [--limit N]

DATABASE_URL is required and is read from the private environment or .env.
The connection string is never printed.
`;
}

export async function runDatabaseCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const { command, options } = parseArguments(argv);
  if (!command || options.help) {
    stdout.write(usage());
    return 0;
  }
  if (!["init", "status", "backup", "trades"].includes(command)) {
    throw cliError(`Unknown database command: ${command}`);
  }

  // A caller-selected host config must not be shadowed by a checkout-local
  // `.env`. Only actual process variables may override `--env-file` values.
  const processEnvironment = io.env ?? process.env;
  const environment = options.envFile
    ? await environmentWithFile(processEnvironment, options.envFile)
    : await environmentWithDefaultFile(processEnvironment);
  const url = databaseUrl(environment);
  if (command !== "init" && url.startsWith("file:") && sqlitePathFromUrl(url) !== ":memory:") {
    if (!(await fileExists(sqlitePathFromUrl(url)))) {
      throw cliError("The configured SQLite database does not exist; run db:init first.", "ERR_DATABASE_NOT_FOUND");
    }
  }
  const client = await createClient(url);
  try {
    if (command === "init") {
      const result = await initializeDatabase(client);
      stdout.write(`${JSON.stringify({
        dialect: client.dialect,
        appliedMigrations: result.migrations.applied,
        accountId: result.account.id,
        healthy: result.status.healthy
      }, null, 2)}\n`);
      return result.status.healthy ? 0 : 1;
    }

    if (command === "status") {
      const result = await databaseStatus(client);
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.healthy ? 0 : 1;
    }

    if (command === "backup") {
      if (!options.output || options.output === "-") {
        throw cliError("db:backup requires --output with a new file path.", "ERR_BACKUP_DESTINATION");
      }
      const result = await backupSqliteDatabase(client, options.output);
      stdout.write(`${JSON.stringify({
        dialect: client.dialect,
        path: result.path,
        pages: result.pages,
        verified: result.verification.integrity === "ok",
        migrations: result.verification.migrations.map((entry) => entry.version)
      }, null, 2)}\n`);
      return 0;
    }

    const format = options.format ?? "json";
    if (!new Set(["json", "csv"]).has(format)) throw cliError("--format must be json or csv.");
    const report = await tradeLedger(client, {
      accountId: options.account,
      sessionId: options.session,
      since: since(options.since),
      limit: options.limit
    });
    const content = format === "csv"
      ? tradeLedgerCsv(report)
      : `${JSON.stringify(report, null, 2)}\n`;
    const path = await output(content, options.output, stdout);
    if (path) stderr.write(`Trade ledger written to ${path}\n`);
    return 0;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runDatabaseCli().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
