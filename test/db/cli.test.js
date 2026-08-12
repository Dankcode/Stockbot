import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { runDatabaseCli } from "../../scripts/database.js";

function capture() {
  let value = "";
  return { stream: { write: (chunk) => { value += chunk; } }, value: () => value };
}

test("database CLI requires a private URL and never echoes it", async () => {
  const stdout = capture();
  const stderr = capture();
  await assert.rejects(
    runDatabaseCli(["status"], { env: {}, stdout: stdout.stream, stderr: stderr.stream }),
    (error) => error?.code === "ERR_DATABASE_URL_REQUIRED"
  );
  assert.equal(stdout.value(), "");
  assert.equal(stderr.value(), "");
});

test("read-only CLI commands do not create a missing SQLite database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-cli-missing-"));
  const databasePath = join(directory, "missing.db");
  try {
    await assert.rejects(
      runDatabaseCli(["status"], {
        env: { DATABASE_URL: pathToFileURL(databasePath).href },
        stdout: capture().stream,
        stderr: capture().stream
      }),
      (error) => error?.code === "ERR_DATABASE_NOT_FOUND"
    );
    await assert.rejects(access(databasePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("database CLI loads owner-only env files without overriding explicit environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-cli-env-"));
  const fileDatabase = join(directory, "file.db");
  const explicitDatabase = join(directory, "explicit.db");
  const environmentPath = join(directory, "stockbot.env");
  try {
    await writeFile(environmentPath, `DATABASE_URL=${pathToFileURL(fileDatabase).href}\n`, { mode: 0o600 });
    const fromFile = capture();
    assert.equal(await runDatabaseCli(["init", "--env-file", environmentPath], {
      env: {},
      stdout: fromFile.stream
    }), 0);
    await access(fileDatabase);
    assert.doesNotMatch(fromFile.value(), /file\.db|DATABASE_URL|file:/);

    const explicit = capture();
    assert.equal(await runDatabaseCli(["init", "--env-file", environmentPath], {
      env: { DATABASE_URL: pathToFileURL(explicitDatabase).href },
      stdout: explicit.stream
    }), 0);
    await access(explicitDatabase);

    await chmod(environmentPath, 0o644);
    await assert.rejects(
      runDatabaseCli(["status", "--env-file", environmentPath], { env: {}, stdout: capture().stream }),
      (error) => error?.code === "ERR_ENV_FILE_PERMISSIONS"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an explicit host env file is not shadowed by the checkout default env", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-cli-precedence-"));
  const checkoutDirectory = join(directory, "checkout");
  const checkoutDatabase = join(directory, "checkout.db");
  const hostDatabase = join(directory, "host.db");
  const hostEnvironment = join(directory, "stockbot.env");
  const previousDirectory = process.cwd();
  try {
    await mkdir(checkoutDirectory);
    await writeFile(join(checkoutDirectory, ".env"), `DATABASE_URL=${pathToFileURL(checkoutDatabase).href}\n`);
    await writeFile(hostEnvironment, `DATABASE_URL=${pathToFileURL(hostDatabase).href}\n`, { mode: 0o600 });
    process.chdir(checkoutDirectory);

    assert.equal(await runDatabaseCli(["init", "--env-file", hostEnvironment], {
      env: {},
      stdout: capture().stream
    }), 0);
    await access(hostDatabase);
    await assert.rejects(access(checkoutDatabase));
  } finally {
    process.chdir(previousDirectory);
    await rm(directory, { recursive: true, force: true });
  }
});

test("database CLI initializes, reports, exports, and backs up an explicit temp URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-cli-"));
  const databasePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  const exportPath = join(directory, "trades.csv");
  const privateUrl = pathToFileURL(databasePath).href;
  const env = { DATABASE_URL: privateUrl };
  try {
    const initialization = capture();
    assert.equal(await runDatabaseCli(["init"], { env, stdout: initialization.stream }), 0);
    assert.equal(JSON.parse(initialization.value()).accountId, "default-paper");
    assert.doesNotMatch(initialization.value(), /source\.db|file:/);

    const status = capture();
    assert.equal(await runDatabaseCli(["status"], { env, stdout: status.stream }), 0);
    assert.equal(JSON.parse(status.value()).healthy, true);
    assert.doesNotMatch(status.value(), /source\.db|file:/);

    const stderr = capture();
    assert.equal(await runDatabaseCli(
      ["trades", "--account", "default-paper", "--format", "csv", "--output", exportPath],
      { env, stdout: capture().stream, stderr: stderr.stream }
    ), 0);
    assert.equal(await readFile(exportPath, "utf8"),
      "order_id,client_order_id,session_id,account_id,session_name,session_mode,symbol,side,order_type,order_qty,order_status,reject_reason,signal_reason,signal_bar_at,submitted_at,resolved_at,fill_id,fill_qty,fill_price,reference_price,commission,notional_cents,filled_at,quote_age_ms\n"
    );

    const backup = capture();
    assert.equal(await runDatabaseCli(["backup", "--output", backupPath], { env, stdout: backup.stream }), 0);
    assert.equal(JSON.parse(backup.value()).verified, true);
    await access(backupPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
