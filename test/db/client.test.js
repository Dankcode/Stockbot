import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient, rewritePlaceholders } from "../../server/db/client.js";

test("rewritePlaceholders ignores SQL literals, identifiers, comments, and dollar quotes", () => {
  const sql = `
    SELECT ?, '?', "?", \`?\`, [?], $$ ? $$, $body$ ? $body$
    -- ? in a line comment
    /* ? in a /* nested ? */ block */
    WHERE first = ? AND second = 'it''s ?' AND third = ?
  `;
  const rewritten = rewritePlaceholders(sql);

  assert.match(rewritten, /SELECT \$1, '\?', "\?", `\?`, \[\?\], \$\$ \? \$\$/);
  assert.match(rewritten, /WHERE first = \$2/);
  assert.match(rewritten, /second = 'it''s \?'/);
  assert.match(rewritten, /third = \$3/);
  assert.match(rewritten, /-- \? in a line comment/);
});

test("SQLite client enforces foreign keys and preserves integers beyond Number safe range", async () => {
  const client = await createClient("file::memory:");
  try {
    await client.exec(`
      CREATE TABLE parent (id TEXT PRIMARY KEY);
      CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent(id),
        exact_value BIGINT NOT NULL
      );
    `);

    await assert.rejects(
      client.execute("INSERT INTO child (id, parent_id, exact_value) VALUES (?, ?, ?)", [
        "child-1",
        "missing",
        1
      ]),
      /FOREIGN KEY/
    );

    const exact = 9_007_199_254_740_993n;
    await client.execute("INSERT INTO parent (id) VALUES (?)", ["parent-1"]);
    await client.execute("INSERT INTO child (id, parent_id, exact_value) VALUES (?, ?, ?)", [
      "child-1",
      "parent-1",
      exact
    ]);
    const [row] = await client.query("SELECT exact_value FROM child WHERE id = ?", ["child-1"]);
    assert.equal(row.exact_value, exact.toString());
  } finally {
    await client.close();
  }
});

test("SQLite transactions commit, roll back, nest with savepoints, and serialize outside work", async () => {
  const client = await createClient("file::memory:");
  try {
    await client.exec("CREATE TABLE events (sequence INTEGER PRIMARY KEY, label TEXT NOT NULL)");

    let releaseTransaction;
    const gate = new Promise((resolve) => {
      releaseTransaction = resolve;
    });
    let firstInsertComplete;
    const firstInsert = new Promise((resolve) => {
      firstInsertComplete = resolve;
    });

    const transaction = client.transaction(async (tx) => {
      await tx.execute("INSERT INTO events (sequence, label) VALUES (?, ?)", [1, "outer-first"]);
      firstInsertComplete();
      await gate;
      await assert.rejects(
        tx.transaction(async (nested) => {
          await nested.execute("INSERT INTO events (sequence, label) VALUES (?, ?)", [2, "nested-rollback"]);
          throw new Error("roll back savepoint");
        }),
        /roll back savepoint/
      );
      await tx.execute("INSERT INTO events (sequence, label) VALUES (?, ?)", [3, "outer-last"]);
    });

    await firstInsert;
    const outside = client.execute("INSERT INTO events (sequence, label) VALUES (?, ?)", [4, "queued-outside"]);
    releaseTransaction();
    await Promise.all([transaction, outside]);

    await assert.rejects(
      client.transaction(async (tx) => {
        await tx.execute("INSERT INTO events (sequence, label) VALUES (?, ?)", [5, "outer-rollback"]);
        throw new Error("roll back transaction");
      }),
      /roll back transaction/
    );

    const rows = await client.query("SELECT sequence, label FROM events ORDER BY sequence");
    assert.deepEqual(rows, [
      { sequence: 1, label: "outer-first" },
      { sequence: 3, label: "outer-last" },
      { sequence: 4, label: "queued-outside" }
    ]);
  } finally {
    await client.close();
    await client.close();
  }
});

test("PostgreSQL adapter rewrites parameters and uses scoped transactional connections", async () => {
  const poolCalls = [];
  const connectionCalls = [];

  class FakePool {
    constructor(configuration) {
      this.configuration = configuration;
    }

    async query(sql, params = []) {
      poolCalls.push({ sql, params });
      return {
        rows: [{ safe: "42", exact: "9007199254740993" }],
        fields: [
          { name: "safe", dataTypeID: 20 },
          { name: "exact", dataTypeID: 20 }
        ],
        rowCount: 1
      };
    }

    async connect() {
      return {
        async query(sql, params = []) {
          connectionCalls.push({ sql, params });
          return { rows: [], fields: [], rowCount: 1 };
        },
        release() {
          connectionCalls.push({ sql: "RELEASE_CONNECTION", params: [] });
        }
      };
    }

    async end() {
      poolCalls.push({ sql: "END_POOL", params: [] });
    }
  }

  const client = await createClient("postgres://stockbot@example.test/stockbot", { Pool: FakePool });
  const rows = await client.query("SELECT ? AS safe, '?' AS literal", [42n]);
  assert.deepEqual(rows, [{ safe: 42, exact: "9007199254740993" }]);
  assert.equal(poolCalls[0].sql, "SELECT $1 AS safe, '?' AS literal");
  assert.deepEqual(poolCalls[0].params, ["42"]);

  await client.transaction(async (transaction) => {
    await transaction.execute("UPDATE accounts SET cash = ? WHERE id = ?", [100n, "account-1"]);
    await assert.rejects(
      transaction.transaction(async (nested) => {
        await nested.execute("UPDATE accounts SET cash = ? WHERE id = ?", [0, "account-1"]);
        throw new Error("nested failure");
      }),
      /nested failure/
    );
  });

  assert.deepEqual(
    connectionCalls.map((call) => call.sql),
    [
      "BEGIN",
      "UPDATE accounts SET cash = $1 WHERE id = $2",
      "SAVEPOINT stockbot_sp_1",
      "UPDATE accounts SET cash = $1 WHERE id = $2",
      "ROLLBACK TO SAVEPOINT stockbot_sp_1",
      "RELEASE SAVEPOINT stockbot_sp_1",
      "COMMIT",
      "RELEASE_CONNECTION"
    ]
  );
  await client.close();
  assert.equal(poolCalls.at(-1).sql, "END_POOL");
});
