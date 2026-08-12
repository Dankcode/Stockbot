import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createClient } from "../../server/db/client.js";
import {
  backupSqliteDatabase,
  databaseStatus,
  initializeDatabase,
  tradeLedger,
  tradeLedgerCsv
} from "../../server/db/operations.js";
import { createRepositories } from "../../server/db/repositories/index.js";

async function temporaryClient() {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-operations-"));
  const filename = join(directory, "stockbot.db");
  const client = await createClient(pathToFileURL(filename).href);
  return { client, directory, filename };
}

test("database initialization is idempotent and validates the durable ledger", async () => {
  const temporary = await temporaryClient();
  try {
    const first = await initializeDatabase(temporary.client, { now: () => 1_000 });
    const second = await initializeDatabase(temporary.client, { now: () => 2_000 });

    assert.deepEqual(first.migrations.applied, [
      "0001_init",
      "0002_order_signal_bar",
      "0003_trade_tracker_indexes"
    ]);
    assert.deepEqual(second.migrations.applied, []);
    assert.equal(second.account.id, "default-paper");
    assert.equal(second.account.createdAt, 1_000);
    assert.equal(second.account.startingCash, 10_000_000);
    assert.equal(second.status.healthy, true);
    assert.equal(second.status.sqlite.journalMode, "wal");
    assert.equal(second.status.sqlite.synchronous, 2);
    assert.deepEqual(second.status.invariants, {
      negativeAccountCash: 0,
      invalidLotQuantity: 0,
      overfilledOrders: 0,
      filledWithoutFill: 0,
      openLotWithoutEntryFill: 0
    });
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test("trade ledger reconciles persisted executions, lots, equity, risk, and audit data", async () => {
  const temporary = await temporaryClient();
  try {
    await initializeDatabase(temporary.client, { now: () => 1_000 });
    const repositories = createRepositories(temporary.client);
    await repositories.sessions.create({
      id: "session-1",
      accountId: "default-paper",
      name: "Laptop automation",
      mode: "paper",
      status: "running",
      symbols: ["AAPL"],
      barInterval: "5min",
      fillModel: { rule: "next_open" },
      startingEquity: 10_000_000,
      createdAt: 2_000
    });
    await repositories.orders.create({
      id: "order-1",
      clientOrderId: "automation-1",
      sessionId: "session-1",
      accountId: "default-paper",
      symbol: "AAPL",
      side: "buy",
      qty: 1_500_000,
      status: "pending",
      signalReason: "EMA cross, then \"confirm\"",
      submittedAt: 3_000
    });
    await repositories.orders.recordFill({
      id: "fill-1",
      orderId: "order-1",
      qty: 1_500_000,
      price: 12_345,
      referencePrice: 12_340,
      commission: 7,
      filledAt: 3_100
    });
    await repositories.orders.createPositionLot({
      id: "lot-1",
      sessionId: "session-1",
      accountId: "default-paper",
      symbol: "AAPL",
      qtyOpen: 1_500_000,
      qtyOriginal: 1_500_000,
      entryPrice: 12_345,
      entryOrderId: "order-1",
      openedAt: 3_100
    });
    await repositories.sessions.addEquitySnapshot({
      sessionId: "session-1",
      at: 3_200,
      equity: 10_010_000,
      cash: 9_800_000,
      positionValue: 210_000
    });
    await repositories.risk.addEvent({
      id: "risk-1",
      sessionId: "session-1",
      accountId: "default-paper",
      at: 3_300,
      ruleId: "exposure",
      severity: "warn",
      actionTaken: "logged",
      detail: { observed: 2.1 }
    });
    await repositories.audit.append({
      id: "audit-1",
      at: 3_400,
      actor: "paper_broker",
      action: "order_filled",
      entity: "order",
      entityId: "order-1"
    });

    const report = await tradeLedger(temporary.client, {
      accountId: "default-paper",
      sessionId: "session-1",
      since: 2_500
    });
    assert.deepEqual(report.summary, {
      orders: 1,
      fills: 1,
      byStatus: { filled: 1 },
      grossBuyCents: 18_518,
      grossSellCents: 0,
      commissionsCents: 7,
      realizedPnlCents: 0,
      openLots: 1,
      riskEvents: 1,
      auditEvents: 1,
      latestEquityCents: 10_010_000,
      latestEquityAt: 3_200
    });
    assert.equal(report.executions[0].notional_cents, 18_518);
    const csv = tradeLedgerCsv(report);
    assert.match(csv, /^order_id,client_order_id,/);
    assert.match(csv, /"EMA cross, then ""confirm"""/);
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});

test("SQLite online backup is verified, atomic, and refuses unsafe destinations", async () => {
  const temporary = await temporaryClient();
  const backupPath = join(temporary.directory, "backups", "snapshot.db");
  try {
    await initializeDatabase(temporary.client, { now: () => 1_000 });
    await assert.rejects(
      backupSqliteDatabase(temporary.client, temporary.filename),
      (error) => error?.code === "ERR_BACKUP_SAME_FILE"
    );
    const result = await backupSqliteDatabase(temporary.client, backupPath, { idFactory: () => "test" });
    assert.equal(result.path, backupPath);
    assert.equal(result.verification.integrity, "ok");
    assert.deepEqual(result.verification.migrations.map((migration) => migration.version), [
      "0001_init",
      "0002_order_signal_bar",
      "0003_trade_tracker_indexes"
    ]);
    await access(backupPath);
    await assert.rejects(
      backupSqliteDatabase(temporary.client, backupPath),
      (error) => error?.code === "ERR_BACKUP_EXISTS"
    );

    const backup = await createClient(pathToFileURL(backupPath).href);
    try {
      assert.equal((await databaseStatus(backup)).healthy, true);
    } finally {
      await backup.close();
    }
    await assert.rejects(readFile(`${backupPath}.tmp-test`));
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
