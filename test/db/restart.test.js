import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";

test("SQLite data and migration state survive a client restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-restart-"));
  const databaseUrl = pathToFileURL(join(directory, "stockbot.db")).href;
  let client;

  try {
    client = await createClient(databaseUrl);
    await migrate(client);
    let repositories = createRepositories(client);
    await repositories.accounts.create({
      id: "account-restart",
      name: "Restart test",
      mode: "paper",
      startingCash: 1_000_000,
      createdAt: 1_000
    });
    await repositories.settings.set({ key: "restart_marker", value: "present", updatedAt: 1_001 });
    await client.close();

    client = await createClient(databaseUrl);
    assert.deepEqual(await migrate(client), {
      applied: [],
      skipped: ["0001_init", "0002_order_signal_bar", "0003_trade_tracker_indexes"]
    });
    repositories = createRepositories(client);
    assert.equal((await repositories.accounts.getById("account-restart")).cash, 1_000_000);
    assert.equal((await repositories.settings.get("restart_marker")).value, "present");

    await assert.rejects(
      client.transaction(async (transaction) => {
        const scoped = createRepositories(transaction);
        await scoped.accounts.adjustBalances("account-restart", { cashDelta: -250_000 });
        await scoped.settings.set({ key: "rolled_back", value: "no", updatedAt: 1_002 });
        throw new Error("simulate crash before commit");
      }),
      /simulate crash/
    );
    await client.close();

    client = await createClient(databaseUrl);
    repositories = createRepositories(client);
    assert.equal((await repositories.accounts.getById("account-restart")).cash, 1_000_000);
    assert.equal(await repositories.settings.get("rolled_back"), null);
  } finally {
    await client?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
