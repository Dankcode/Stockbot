/**
 * PostgreSQL cutover rehearsal on a DISPOSABLE server.
 *
 *   STOCKBOT_TEST_POSTGRES_URL=postgres://admin@127.0.0.1:5432/postgres node --test test/db/postgres-migration.test.js
 *
 * The URL needs CREATEDB; every database this creates is named stockbot_rehearsal_*
 * and dropped at the end. Never point it at the production database. It:
 *   1. builds a database at the pre-swarm schema (0001–0005) holding the kinds of
 *      records production has, including 24 inactive legacy sessions;
 *   2. pg_dump's it (the backup taken before cutover);
 *   3. migrates a restored copy to 0006 and proves every existing row is unchanged;
 *   4. runs one swarm cycle on PostgreSQL through the real server;
 *   5. dump/restores the migrated database and proves the restore is identical and
 *      already fully migrated; and restores the pre-cutover dump to prove rollback.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createStockbot } from "../../server/bootstrap.js";
import { loadConfig } from "../../server/config/index.js";
import { createClient } from "../../server/db/client.js";
import { DEFAULT_MIGRATIONS_DIRECTORY, getAppliedMigrations, migrate, readMigrations } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { PRE_SWARM_TABLES, fingerprintTables as fingerprint } from "../../server/db/fingerprint.js";
import { fixtureMarket, PLAN } from "../swarm/fixture.js";
import { EXPECTED_MIGRATIONS, SWARM_COLUMNS } from "./expected-schema.js";

const exec = promisify(execFile);
const ADMIN_URL = process.env.STOCKBOT_TEST_POSTGRES_URL;
const PG_BIN = process.env.STOCKBOT_TEST_PG_BIN ?? "";
const bin = (name) => (PG_BIN ? path.join(PG_BIN, name) : name);
const LEGACY_SESSIONS = 24;

function databaseUrl(name) {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin(sql) {
  const client = await createClient(ADMIN_URL);
  try { await client.exec(sql); } finally { await client.close(); }
}

async function seedProductionShape(client) {
  const repositories = createRepositories(client);
  const at = Date.UTC(2026, 8, 20);
  await repositories.accounts.create({ id: "default-paper", name: "Stockbot Paper", mode: "paper", startingCash: 10_000_000, createdAt: at });
  for (let index = 1; index <= LEGACY_SESSIONS; index += 1) {
    const errored = index % 3 !== 0;
    await client.execute(
      `INSERT INTO sessions (id, account_id, name, mode, status, symbols_json, bar_interval, fill_model_json,
         starting_equity, created_at, started_at, ended_at, stop_reason, error_detail)
       VALUES (?, 'default-paper', ?, 'paper', ?, '["SPY"]', '1day', '{"slippageBps":5}', 10000000, ?, ?, ?, ?, ?)`,
      [`legacy-${String(index).padStart(2, "0")}`, `Legacy ${index}`, errored ? "errored" : "stopped", at + index, at + index, at + index + 1,
        errored ? "error" : "operator", errored ? "Session was running when the server restarted." : null]
    );
  }
  for (const [index, side] of [[1, "buy"], [2, "sell"], [3, "buy"]].map(([n, s]) => [n, s])) {
    await client.execute(
      `INSERT INTO orders (id, client_order_id, session_id, account_id, symbol, side, qty, status, signal_reason, submitted_at, resolved_at)
       VALUES (?, ?, 'legacy-01', 'default-paper', 'SPY', ?, 1000000, 'filled', 'legacy signal', ?, ?)`,
      [`order-${index}`, `legacy-order-${index}`, side, at + index, at + index]
    );
    await client.execute(
      "INSERT INTO fills (id, order_id, qty, price, reference_price, commission, filled_at, quote_age_ms) VALUES (?, ?, 1000000, 50000, 49990, 0, ?, 120)",
      [`fill-${index}`, `order-${index}`, at + index]
    );
  }
  await repositories.settings.set({ key: "marker", value: "pre-swarm", updatedAt: at });
  await repositories.research.importPlan({
    planId: "legacy-plan", name: "Legacy research", description: null, sourceHash: "legacy-hash",
    manifest: { steps: [{ type: "web_page" }] }, versionId: "legacy-plan-v1", at
  });
  await repositories.audit.append({ id: "audit-legacy", at, actor: "operator", action: "session_created", entity: "session", entityId: "legacy-01", detail: { note: "seed" } });
}

test("PostgreSQL: migrate a restored pre-swarm backup, preserve every record, run a cycle, dump/restore and roll back", { skip: !ADMIN_URL && "set STOCKBOT_TEST_POSTGRES_URL to a disposable server" }, async (t) => {
  const suffix = `${Date.now()}_${process.pid}`;
  const names = { source: `stockbot_rehearsal_src_${suffix}`, cutover: `stockbot_rehearsal_cut_${suffix}`, restored: `stockbot_rehearsal_res_${suffix}`, rollback: `stockbot_rehearsal_rb_${suffix}` };
  const scratch = await mkdtemp(path.join(tmpdir(), "stockbot-pg-"));
  // One ordered cleanup: close what the test opened (newest first), then drop the scratch databases.
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
    for (const name of Object.values(names)) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  });
  for (const name of Object.values(names)) await admin(`CREATE DATABASE ${name}`);

  // 1. Production today: schema 0001–0005 with existing records.
  const preSwarm = path.join(scratch, "migrations-0005");
  await mkdir(preSwarm);
  for (const migration of (await readMigrations()).filter((entry) => entry.version < "0006")) {
    await copyFile(path.join(DEFAULT_MIGRATIONS_DIRECTORY, migration.file), path.join(preSwarm, migration.file));
  }
  const source = await createClient(databaseUrl(names.source));
  assert.deepEqual((await migrate(source, { directory: preSwarm })).applied, EXPECTED_MIGRATIONS.slice(0, 5));
  await seedProductionShape(source);
  const before = await fingerprint(source, PRE_SWARM_TABLES);
  const legacyBefore = await source.query("SELECT status, COUNT(*) AS n FROM sessions GROUP BY status ORDER BY status");
  await source.close();

  // 2. The pre-cutover backup.
  const preDump = path.join(scratch, "pre-cutover.dump");
  await exec(bin("pg_dump"), ["--format=custom", "--no-owner", "--file", preDump, databaseUrl(names.source)]);

  // 3. Rehearse the cutover on a restored copy, never on the source.
  await exec(bin("pg_restore"), ["--no-owner", "--exit-on-error", "--dbname", databaseUrl(names.cutover), preDump]);
  const cutover = await createClient(databaseUrl(names.cutover));
  cleanups.push(() => cutover.close());
  assert.deepEqual(await fingerprint(cutover, PRE_SWARM_TABLES), before, "the restore matches the source before migrating");
  assert.deepEqual(await migrate(cutover), { applied: ["0006_swarm"], skipped: EXPECTED_MIGRATIONS.slice(0, 5) });
  assert.deepEqual(await fingerprint(cutover, PRE_SWARM_TABLES), before, "0006 changes no existing row");
  assert.deepEqual((await getAppliedMigrations(cutover)).map((entry) => entry.version), [...EXPECTED_MIGRATIONS]);
  for (const [table, columns] of Object.entries(SWARM_COLUMNS)) {
    const actual = await cutover.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
      [table]
    );
    assert.deepEqual(actual.map((row) => row.column_name), columns, `${table} columns on PostgreSQL`);
  }

  // 4. One swarm cycle on PostgreSQL through the real server (scheduler off, as in any non-supervisor process).
  const runtime = await createStockbot({
    config: { ...loadConfig(), databaseUrl: databaseUrl(names.cutover), apiToken: "operator-token-that-is-at-least-32-characters-long", engineWorkers: 1, swarmScheduler: false, restartRunningSessions: false },
    client: cutover,
    market: fixtureMarket({ provider: "alpaca" })
  });
  const { swarm, intents, scheduler, repositories } = runtime;
  let runtimeOpen = true;
  const closeRuntime = async () => {
    if (!runtimeOpen) return;
    runtimeOpen = false;
    await scheduler.stop();
    await runtime.supervisor.close();
    await runtime.enginePool.close();
  };
  cleanups.push(closeRuntime);
  const agent = await swarm.createAgent({ name: "alpha" });
  await swarm.savePlan(agent.id, PLAN);
  assert.equal((await scheduler.tick()).created, 1);
  const [task] = await repositories.swarm.listTasks({ agentId: agent.id, status: "pending" });
  await swarm.claimTask(agent, task.id);
  const receipt = await swarm.retrieve(agent, task.id, { kind: "market.quote", symbol: "SPY" });
  const { decisions } = await swarm.submitReport(agent, task.id, {
    summary: "Hold.", decisions: [{ symbol: "SPY", action: "hold", rationale: "No setup.", evidence: [receipt.receiptId] }]
  });
  assert.equal((await repositories.swarm.getTask(task.id)).status, "completed");
  const refused = await intents.submit(await repositories.swarm.getAgent(agent.id), { idempotencyKey: "pg-intent-0001", decisionId: decisions[0].id, symbol: "SPY", side: "buy", notional: 1_000 });
  assert.equal(refused.intent.rejectCode, "intents_disabled");
  assert.deepEqual(await cutover.query("SELECT status, COUNT(*) AS n FROM sessions GROUP BY status ORDER BY status"), legacyBefore, "legacy sessions stay inactive");
  // Booting any Stockbot server syncs the bundled strategies into algorithms/algorithm_versions;
  // beyond that, the swarm may add only its sleeve account and audit rows.
  const touched = new Set(["accounts", "audit_log", "algorithms", "algorithm_versions"]);
  const untouched = (print) => Object.fromEntries(Object.entries(print).filter(([table]) => !touched.has(table)));
  assert.deepEqual(untouched(await fingerprint(cutover, PRE_SWARM_TABLES)), untouched(before), "the swarm wrote nothing else");
  assert.deepEqual(
    (await cutover.query("SELECT id FROM accounts ORDER BY id")).map((row) => row.id),
    ["default-paper", "sleeve-alpha"],
    "the only new account is the agent's sleeve"
  );
  const existingAccount = await cutover.query("SELECT * FROM accounts WHERE id = 'default-paper'");
  assert.equal(existingAccount[0].cash, 10_000_000);
  await closeRuntime();
  const migratedPrint = await fingerprint(cutover, [...PRE_SWARM_TABLES, ...Object.keys(SWARM_COLUMNS), "schema_migrations"]);

  // 5a. Backup/restore of the migrated database is exact and needs no further migration.
  const postDump = path.join(scratch, "post-cutover.dump");
  await exec(bin("pg_dump"), ["--format=custom", "--no-owner", "--file", postDump, databaseUrl(names.cutover)]);
  await exec(bin("pg_restore"), ["--no-owner", "--exit-on-error", "--dbname", databaseUrl(names.restored), postDump]);
  const restored = await createClient(databaseUrl(names.restored));
  try {
    assert.deepEqual(await fingerprint(restored, [...PRE_SWARM_TABLES, ...Object.keys(SWARM_COLUMNS), "schema_migrations"]), migratedPrint);
    assert.deepEqual(await migrate(restored), { applied: [], skipped: [...EXPECTED_MIGRATIONS] }, "checksums survive the restore");
    // Stopping the supervisor released its lease, so the restored copy has no leader recorded.
    assert.equal(Number((await restored.query("SELECT COUNT(*) AS n FROM swarm_leases"))[0].n), 0);
  } finally { await restored.close(); }

  // 5b. Rollback = restore the pre-cutover dump: original schema and records, nothing from the swarm.
  await exec(bin("pg_restore"), ["--no-owner", "--exit-on-error", "--dbname", databaseUrl(names.rollback), preDump]);
  const rollback = await createClient(databaseUrl(names.rollback));
  try {
    assert.deepEqual(await fingerprint(rollback, PRE_SWARM_TABLES), before);
    assert.deepEqual((await getAppliedMigrations(rollback)).map((entry) => entry.version), EXPECTED_MIGRATIONS.slice(0, 5));
    assert.deepEqual(await rollback.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'agent%'"), []);
  } finally { await rollback.close(); }
});
