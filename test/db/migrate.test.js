import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createClient } from "../../server/db/client.js";
import { getAppliedMigrations, migrate } from "../../server/db/migrate.js";

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-migrate-"));
  const filename = join(directory, "stockbot.db");
  const client = await createClient(pathToFileURL(filename).href);
  return { client, directory, filename };
}

test("initial migration creates the complete schema and is idempotent", async () => {
  const temporary = await temporaryDatabase();
  try {
    const first = await migrate(temporary.client, { now: () => 1_700_000_000_000 });
    const second = await migrate(temporary.client, { now: () => 1_800_000_000_000 });

    assert.deepEqual(first, {
      applied: ["0001_init", "0002_order_signal_bar", "0003_trade_tracker_indexes", "0004_ai_research"],
      skipped: []
    });
    assert.deepEqual(second, {
      applied: [],
      skipped: ["0001_init", "0002_order_signal_bar", "0003_trade_tracker_indexes", "0004_ai_research"]
    });

    const tables = await temporary.client.query(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name",
      ["table", "sqlite_%"]
    );
    assert.deepEqual(
      tables.map((row) => row.name),
      [
        "accounts",
        "alert_deliveries",
        "alerts",
        "algorithm_versions",
        "algorithms",
        "audit_log",
        "backtest_runs",
        "equity_snapshots",
        "fills",
        "orders",
        "position_lots",
        "research_documents",
        "research_plan_versions",
        "research_plans",
        "research_runs",
        "research_snapshots",
        "risk_events",
        "risk_profiles",
        "schema_migrations",
        "session_events",
        "session_metrics",
        "sessions",
        "settings"
      ]
    );

    const applied = await getAppliedMigrations(temporary.client);
    assert.equal(applied.length, 4);
    assert.ok(applied.every((migration) => migration.appliedAt === 1_700_000_000_000));
    assert.ok(applied.every((migration) => migration.checksum.length === 64));

    const sessionColumns = await temporary.client.query("PRAGMA table_info(sessions)");
    const orderColumns = await temporary.client.query("PRAGMA table_info(orders)");
    assert.ok(sessionColumns.some((column) => column.name === "research_plan_version_id"));
    assert.ok(orderColumns.some((column) => column.name === "research_snapshot_id"));

    const sessionForeignKeys = await temporary.client.query("PRAGMA foreign_key_list(sessions)");
    const orderForeignKeys = await temporary.client.query("PRAGMA foreign_key_list(orders)");
    assert.ok(sessionForeignKeys.some((foreignKey) =>
      foreignKey.from === "research_plan_version_id" && foreignKey.table === "research_plan_versions"
    ));
    assert.ok(orderForeignKeys.some((foreignKey) =>
      foreignKey.from === "research_snapshot_id" && foreignKey.table === "research_snapshots"
    ));

    const indexes = await temporary.client.query(
      "SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? AND name NOT LIKE ? ORDER BY name",
      ["index", "%research%", "sqlite_autoindex_%"]
    );
    assert.deepEqual(indexes.map((index) => index.name), [
      "idx_orders_research_snapshot",
      "idx_research_documents_content",
      "idx_research_documents_run",
      "idx_research_plan_versions_plan",
      "idx_research_plans_created",
      "idx_research_runs_plan",
      "idx_research_runs_plan_symbol",
      "idx_research_runs_status",
      "idx_research_runs_symbol",
      "idx_research_snapshots_eligible",
      "idx_research_snapshots_run",
      "idx_research_snapshots_timeline",
      "idx_sessions_research_plan_version"
    ]);
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test("migration checksum drift fails loudly", async () => {
  const temporary = await temporaryDatabase();
  const migrationsDirectory = join(temporary.directory, "migrations");
  await mkdir(migrationsDirectory);
  const migrationPath = join(migrationsDirectory, "0001_example.sql");

  try {
    await writeFile(migrationPath, "CREATE TABLE example (id TEXT PRIMARY KEY);\n");
    await migrate(temporary.client, { directory: migrationsDirectory });
    await writeFile(migrationPath, "CREATE TABLE example (id TEXT PRIMARY KEY, name TEXT);\n");

    await assert.rejects(
      migrate(temporary.client, { directory: migrationsDirectory }),
      (error) => error?.code === "ERR_MIGRATION_DRIFT" && error?.version === "0001_example"
    );
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test("a failed migration rolls back its schema and tracking row", async () => {
  const temporary = await temporaryDatabase();
  const migrationsDirectory = join(temporary.directory, "migrations");
  await mkdir(migrationsDirectory);

  try {
    await writeFile(join(migrationsDirectory, "0001_good.sql"), "CREATE TABLE good_table (id TEXT PRIMARY KEY);\n");
    await writeFile(
      join(migrationsDirectory, "0002_bad.sql"),
      "CREATE TABLE half_created (id TEXT PRIMARY KEY);\nTHIS IS NOT SQL;\n"
    );

    await assert.rejects(migrate(temporary.client, { directory: migrationsDirectory }));
    const halfCreated = await temporary.client.query(
      "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      ["table", "half_created"]
    );
    assert.deepEqual(halfCreated, []);
    assert.deepEqual(
      (await getAppliedMigrations(temporary.client)).map((migration) => migration.version),
      ["0001_good"]
    );
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
