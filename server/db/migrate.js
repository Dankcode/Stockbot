import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(new URL("./migrations/", import.meta.url));
const MIGRATION_FILE = /^(\d{4,}[^/]*)\.sql$/;

function migrationError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function checksum(source) {
  return createHash("sha256").update(source).digest("hex");
}

function directoryPath(directory) {
  if (directory instanceof URL) {
    return fileURLToPath(directory);
  }
  return resolve(String(directory));
}

export async function readMigrations(directory = DEFAULT_MIGRATIONS_DIRECTORY) {
  const path = directoryPath(directory);
  const entries = await readdir(path, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const seen = new Set();
  const migrations = [];
  for (const file of files) {
    const match = file.match(MIGRATION_FILE);
    if (!match) {
      throw migrationError(
        `Invalid migration filename ${file}; expected a numeric prefix such as 0001_init.sql.`,
        "ERR_MIGRATION_FILENAME",
        { file }
      );
    }
    const version = match[1];
    if (seen.has(version)) {
      throw migrationError(`Duplicate migration version ${version}.`, "ERR_MIGRATION_DUPLICATE", { version, file });
    }
    seen.add(version);
    const source = await readFile(resolve(path, file), "utf8");
    migrations.push({ version, file, source, checksum: checksum(source) });
  }
  return migrations;
}

export async function ensureMigrationTable(client) {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    )
  `);
}

export async function getAppliedMigrations(client) {
  await ensureMigrationTable(client);
  const rows = await client.query("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version");
  return rows.map((row) => ({ version: row.version, checksum: row.checksum, appliedAt: row.applied_at }));
}

/**
 * Applies each migration exactly once in its own transaction. Applied files
 * are checksummed so editing history fails loudly instead of silently
 * changing the meaning of an existing database.
 */
export async function migrate(client, options = {}) {
  if (!client || typeof client.transaction !== "function") {
    throw new TypeError("migrate(client) requires a database client.");
  }

  const migrations = await readMigrations(options.directory ?? DEFAULT_MIGRATIONS_DIRECTORY);
  await ensureMigrationTable(client);
  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    const outcome = await client.transaction(async (transaction) => {
      if (transaction.dialect === "postgres") {
        await transaction.exec("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
      }

      const existing = await transaction.query(
        "SELECT version, checksum FROM schema_migrations WHERE version = ?",
        [migration.version]
      );
      if (existing[0]) {
        if (existing[0].checksum !== migration.checksum) {
          throw migrationError(
            `Migration ${migration.version} was modified after it was applied.`,
            "ERR_MIGRATION_DRIFT",
            {
              version: migration.version,
              file: migration.file,
              expectedChecksum: existing[0].checksum,
              actualChecksum: migration.checksum
            }
          );
        }
        return "skipped";
      }

      await transaction.exec(migration.source);
      await transaction.execute(
        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.checksum, options.now?.() ?? Date.now()]
      );
      return "applied";
    });

    if (outcome === "applied") {
      applied.push(migration.version);
      options.logger?.info?.(`Applied migration ${migration.file}`);
    } else {
      skipped.push(migration.version);
    }
  }

  return { applied, skipped };
}

export { DEFAULT_MIGRATIONS_DIRECTORY };
