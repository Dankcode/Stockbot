#!/usr/bin/env node
/**
 * Controlled PostgreSQL cutover to the swarm schema (0006) and the single supervisor.
 *
 *   node scripts/swarm/cutover.js rehearse --env-file ~/.config/stockbot/stockbot.env --admin-url <url>
 *   node scripts/swarm/cutover.js apply    --env-file ~/.config/stockbot/stockbot.env
 *   node scripts/swarm/cutover.js rollback --env-file ~/.config/stockbot/stockbot.env --dump <file>
 *
 * rehearse  pg_dump's production (read-only), restores it into a scratch database on a
 *           server where --admin-url may CREATE DATABASE, migrates the copy, proves every
 *           existing row is unchanged, and drops the copy. Writes a rehearsal record.
 * apply     requires a passing rehearsal from the last 24h for the same database, stops the
 *           service, takes a verified pg_dump, migrates, re-checks every existing row,
 *           enables SWARM_SCHEDULER=1 in the env file (exactly one supervisor), starts the
 *           service and checks health, the swarm lease and that orders are still disabled.
 * rollback  stops the service, restores the pre-cutover dump over the database, removes
 *           SWARM_SCHEDULER from the env file and prints the git checkout to run before starting.
 *
 * Service control defaults to the launchd agent installed by scripts/laptop/install.sh
 * (com.stockbot.laptop). Override with STOCKBOT_SERVICE_STOP / STOCKBOT_SERVICE_START
 * (shell commands) on other hosts. pg_dump/pg_restore come from PATH or STOCKBOT_PG_BIN.
 * Strategy sessions are not touched: RESTART_RUNNING_SESSIONS must stay off, so the
 * legacy sessions remain inactive.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseEnv } from "node:util";

import { createClient } from "../../server/db/client.js";
import { diffFingerprints, fingerprintTables, PRE_SWARM_TABLES } from "../../server/db/fingerprint.js";
import { getAppliedMigrations, migrate, readMigrations } from "../../server/db/migrate.js";
import { redact } from "../lib/hermes.js";

const run = promisify(execFile);
/** Runs an operator-supplied service command without pipes, so a daemon it starts cannot hold us open. */
function shell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: root, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(fail(`Service command exited ${code}: ${command}`))));
  });
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LABEL = "com.stockbot.laptop";
const REHEARSAL_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const pgBin = (name) => (process.env.STOCKBOT_PG_BIN ? path.join(process.env.STOCKBOT_PG_BIN, name) : name);

function fail(message) {
  const error = new Error(message);
  error.code = "CUTOVER_ABORTED";
  return error;
}

export function parseOptions(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!["--env-file", "--admin-url", "--dump", "--backup-dir"].includes(key) || rest[index + 1] === undefined) {
      throw fail("Usage: cutover.js rehearse|apply|rollback --env-file <file> [--admin-url <url>] [--dump <file>] [--backup-dir <dir>]");
    }
    options[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest[index + 1];
  }
  if (!["rehearse", "apply", "rollback"].includes(command)) throw fail("Command must be rehearse, apply or rollback.");
  options.envFile ??= path.join(os.homedir(), ".config", "stockbot", "stockbot.env");
  options.backupDir ??= path.join(os.homedir(), ".local", "state", "stockbot", "cutover");
  return options;
}

async function loadEnv(file) {
  const metadata = await stat(file).catch(() => null);
  if (!metadata?.isFile()) throw fail(`Env file not found: ${file}`);
  if ((metadata.mode & 0o077) !== 0) throw fail(`${file} must be chmod 600.`);
  const values = parseEnv(await readFile(file, "utf8"));
  if (!/^postgres(?:ql)?:\/\//i.test(values.DATABASE_URL ?? "")) throw fail("DATABASE_URL in the env file must be a PostgreSQL URL.");
  if (["1", "true", "yes", "on"].includes(String(values.RESTART_RUNNING_SESSIONS ?? "").toLowerCase())) {
    throw fail("RESTART_RUNNING_SESSIONS is on; turn it off so legacy sessions stay inactive.");
  }
  return values;
}

/** Identity of the target database without the password, for matching rehearsal to apply. */
function databaseIdentity(url) {
  const parsed = new URL(url);
  return createHash("sha256").update(`${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}:${decodeURIComponent(parsed.username)}`).digest("hex").slice(0, 16);
}

function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * Runs a PostgreSQL client tool with the password in PGPASSWORD, never on argv
 * (where `ps` and error messages would show it). Failures are redacted.
 */
async function pgTool(name, args, url) {
  const env = { ...process.env };
  const finalArgs = args.map((arg) => {
    if (arg !== url) return arg;
    const parsed = new URL(url);
    if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
    parsed.password = "";
    return parsed.toString();
  });
  try {
    return await run(pgBin(name), finalArgs, { env, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail = redact(String(error.stderr || error.message || "").split("\n").filter(Boolean).slice(-5).join("\n"));
    throw fail(`${name} failed: ${detail}`);
  }
}

async function listDump(file) {
  const { stdout } = await pgTool("pg_restore", ["--list", file]);
  return stdout;
}

async function pgDump(url, file) {
  await pgTool("pg_dump", ["--format=custom", "--no-owner", "--file", file, url], url);
  await chmod(file, 0o600);
  if (!/TABLE DATA \S+ accounts /.test(await listDump(file))) throw fail(`Backup ${file} does not list the accounts table; refusing to continue.`);
  return file;
}

async function migrationState(client) {
  const applied = (await getAppliedMigrations(client)).map((entry) => entry.version);
  const available = (await readMigrations()).map((entry) => entry.version);
  return { applied, pending: available.filter((version) => !applied.includes(version)) };
}

async function rehearse(options, log) {
  if (!options.adminUrl) throw fail("rehearse needs --admin-url: a role on a disposable or production server that may CREATE DATABASE.");
  const env = await loadEnv(options.envFile);
  await mkdir(options.backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dump = await pgDump(env.DATABASE_URL, path.join(options.backupDir, `rehearsal-source-${stamp}.dump`));
  const scratch = `stockbot_rehearsal_${Date.now()}`;
  const admin = await createClient(options.adminUrl);
  await admin.exec(`CREATE DATABASE ${scratch}`);
  try {
    const scratchUrl = withDatabase(options.adminUrl, scratch);
    await pgTool("pg_restore", ["--no-owner", "--exit-on-error", "--dbname", scratchUrl, dump], scratchUrl);
    const copy = await createClient(scratchUrl);
    try {
      const state = await migrationState(copy);
      const tables = PRE_SWARM_TABLES;
      const before = await fingerprintTables(copy, tables);
      const result = await migrate(copy);
      const changed = diffFingerprints(before, await fingerprintTables(copy, tables));
      if (changed.length) throw fail(`Rehearsal changed existing rows in: ${changed.join(", ")}`);
      const sessions = await copy.query("SELECT status, COUNT(*) AS n FROM sessions GROUP BY status ORDER BY status");
      const record = {
        rehearsedAt: Date.now(), database: databaseIdentity(env.DATABASE_URL), before: state, applied: result.applied,
        tables: Object.fromEntries(Object.entries(before).map(([table, value]) => [table, Number(value.split(":")[0])])),
        sessions: Object.fromEntries(sessions.map((row) => [row.status, Number(row.n)])), sourceDump: dump
      };
      const recordFile = path.join(options.backupDir, "rehearsal.json");
      await writeFile(recordFile, JSON.stringify(record, null, 2), { mode: 0o600 });
      log({ rehearsal: "passed", applied: result.applied, unchangedTables: tables.length, rows: record.tables, sessions: record.sessions, record: recordFile });
      return record;
    } finally { await copy.close(); }
  } finally {
    await admin.exec(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  }
}

async function service(action) {
  const custom = action === "stop" ? process.env.STOCKBOT_SERVICE_STOP : process.env.STOCKBOT_SERVICE_START;
  if (custom) return shell(custom);
  const domain = `gui/${process.getuid()}`;
  if (action === "stop") return run("/bin/launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => undefined);
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  await run("/bin/launchctl", ["bootstrap", domain, plist]).catch(() => undefined);
  return run("/bin/launchctl", ["kickstart", "-k", `${domain}/${LABEL}`]);
}

async function waitFor(check, { timeoutMs = 60_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw fail(`Timed out waiting for the service${last ? ` (${last.message})` : ""}.`);
}

async function setEnvLine(file, key, value) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/).filter((line) => !line.startsWith(`${key}=`));
  if (value !== null) lines.splice(lines.length && lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${key}=${value}`);
  await writeFile(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}

async function api(env, route) {
  const response = await fetch(`http://127.0.0.1:${env.PORT || 4000}/api/v1${route}`, { headers: { "x-stockbot-token": env.STOCKBOT_API_TOKEN ?? "" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  return payload.data;
}

async function portFree(env) {
  try { await fetch(`http://127.0.0.1:${env.PORT || 4000}/api/v1/health`, { signal: AbortSignal.timeout(1_000) }); return false; }
  catch { return true; }
}

async function apply(options, log) {
  const env = await loadEnv(options.envFile);
  const record = JSON.parse(await readFile(path.join(options.backupDir, "rehearsal.json"), "utf8").catch(() => "null"));
  if (!record) throw fail("No rehearsal record. Run `cutover.js rehearse` first.");
  if (record.database !== databaseIdentity(env.DATABASE_URL)) throw fail("The rehearsal was for a different database.");
  if (Date.now() - record.rehearsedAt > REHEARSAL_MAX_AGE_MS) throw fail("The rehearsal is older than 24 hours; rehearse again.");

  log("Stopping the Stockbot service…");
  await service("stop");
  await waitFor(() => portFree(env), { timeoutMs: 30_000 });

  const client = await createClient(env.DATABASE_URL);
  let dump;
  try {
    const state = await migrationState(client);
    if (!state.pending.length) throw fail("Nothing to migrate; the database is already at the latest schema.");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    dump = await pgDump(env.DATABASE_URL, path.join(options.backupDir, `stockbot-pre-${state.pending[0]}-${stamp}.dump`));
    log({ backup: dump, pending: state.pending });
    const before = await fingerprintTables(client, PRE_SWARM_TABLES);
    const result = await migrate(client);
    const changed = diffFingerprints(before, await fingerprintTables(client, PRE_SWARM_TABLES));
    if (changed.length) throw fail(`Migration changed existing rows in ${changed.join(", ")}. Roll back with: cutover.js rollback --dump ${dump}`);
    log({ migrated: result.applied, existingRowsUnchanged: true });
  } finally { await client.close(); }

  await writeFile(path.join(options.backupDir, "apply.json"), JSON.stringify({ appliedAt: Date.now(), database: databaseIdentity(env.DATABASE_URL), dump }, null, 2), { mode: 0o600 });
  await setEnvLine(options.envFile, "SWARM_SCHEDULER", "1");
  log("Starting the single supervisor (SWARM_SCHEDULER=1)…");
  const startedAt = Date.now();
  await service("start");
  const health = await waitFor(async () => { const value = await api(env, "/health"); return value?.ok ? value : null; });
  const swarm = await waitFor(() => api(env, "/swarm"));
  const verify = await createClient(env.DATABASE_URL);
  try {
    // The service just started must be the one holding the lease (acquired after start).
    const leases = await waitFor(async () => {
      const rows = await verify.query(
        "SELECT holder, acquired_at FROM swarm_leases WHERE name = 'swarm-supervisor' AND expires_at > ? AND acquired_at >= ?",
        [Date.now(), startedAt]
      );
      return rows.length ? rows : null;
    }, { timeoutMs: 90_000 });
    if (swarm.intentsEnabled) throw fail("Orders are enabled after cutover; they must start disabled.");
    const summary = { cutover: "complete", backup: dump, health: { ok: health.ok, database: health.database }, supervisor: leases[0].holder, ordersEnabled: swarm.intentsEnabled, agents: swarm.agents.length };
    log(summary);
    log(`Rollback, if needed: node scripts/swarm/cutover.js rollback --env-file ${options.envFile} --dump ${dump}`);
    return summary;
  } finally { await verify.close(); }
}

const SWARM_TABLES = ["agent_intents", "agent_decisions", "report_evidence", "agent_reports", "retrieval_receipts", "agent_tasks", "agent_plans", "agent_tokens", "agents", "swarm_leases"];

async function rollback(options, log) {
  if (!options.dump) throw fail("rollback needs --dump <the pre-cutover backup that apply printed>.");
  const env = await loadEnv(options.envFile);
  const applied = JSON.parse(await readFile(path.join(options.backupDir, "apply.json"), "utf8").catch(() => "null"));
  if (!applied) throw fail("No apply record in the backup directory; refusing to restore a dump that apply did not take.");
  if (applied.database !== databaseIdentity(env.DATABASE_URL)) throw fail("The apply record is for a different database.");
  if (path.resolve(options.dump) !== path.resolve(applied.dump)) throw fail(`--dump must be the pre-cutover backup apply took: ${applied.dump}`);
  const listing = await listDump(options.dump);
  if (/TABLE \S+ agents /.test(listing)) throw fail("That dump already contains the swarm schema; it is not a pre-cutover backup.");

  log("Stopping the Stockbot service…");
  await service("stop");
  await waitFor(() => portFree(env), { timeoutMs: 30_000 });
  // Keep what was recorded since cutover before anything changes.
  await mkdir(options.backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshot = await pgDump(env.DATABASE_URL, path.join(options.backupDir, `stockbot-before-rollback-${stamp}.dump`));
  log({ savedCurrentState: snapshot, note: "Rows written to existing tables after cutover (sleeve accounts, audit) are reverted by the restore; they remain in this dump." });

  // One transaction: drop the swarm tables and restore the pre-cutover dump. If
  // anything fails, psql rolls all of it back and the database is left as it was.
  const script = path.join(options.backupDir, `rollback-${stamp}.sql`);
  await pgTool("pg_restore", ["--clean", "--if-exists", "--no-owner", "--file", script, options.dump]);
  await chmod(script, 0o600); // pg_restore creates it with the default umask; it is a full copy of the data
  const restoreSql = await readFile(script, "utf8");
  await writeFile(script, `${SWARM_TABLES.map((table) => `DROP TABLE IF EXISTS ${table};`).join("\n")}\n${restoreSql}`, { mode: 0o600 });
  try {
    await pgTool("psql", ["--no-psqlrc", "--quiet", "--single-transaction", "--set", "ON_ERROR_STOP=1", "--file", script, "--dbname", env.DATABASE_URL], env.DATABASE_URL);
  } finally {
    await unlink(script).catch(() => undefined);
  }

  const restored = await createClient(env.DATABASE_URL);
  try {
    const state = await migrationState(restored);
    if (state.applied.includes("0006_swarm")) throw fail("Restore finished but schema_migrations still lists 0006; investigate before starting.");
    await setEnvLine(options.envFile, "SWARM_SCHEDULER", null);
    log({ rollback: "restored", applied: state.applied, savedCurrentState: snapshot, next: "Check out the commit before the swarm (git checkout <previous commit>), then start the service." });
    return state;
  } finally { await restored.close(); }
}

export async function main(argv = process.argv.slice(2), log = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`)) {
  const options = parseOptions(argv);
  if (options.command === "rehearse") return rehearse(options, log);
  if (options.command === "apply") return apply(options, log);
  return rollback(options, log);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
