import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDatabaseUrl,
  configuredEnvironment,
  createDatabaseSettingsService,
  parseDatabaseProfile,
  updateEnvironmentSource
} from "../../server/settings/database-service.js";

const CURRENT_PASSWORD = "current password with :/?#[]@!$&'()*+,;=\"\\";
const CURRENT_URL = buildDatabaseUrl({
  location: "remote",
  hostname: "database.internal.example",
  connectAddress: "fd7a:115c:a1e0::42",
  port: 5432,
  database: "stockbot",
  username: "stockbot",
  password: CURRENT_PASSWORD,
  sslMode: "verify-full"
});

function profile(overrides = {}) {
  return {
    location: "remote",
    hostname: "new-database.internal.example",
    connectAddress: "10.20.30.40",
    port: 5544,
    database: "stockbot target",
    username: "stockbot operator",
    password: "replacement password with ' and \\ characters",
    sslMode: "require",
    ...overrides
  };
}

function repositories(activeStatus = null) {
  const requested = [];
  return {
    requested,
    sessions: {
      async list(options) {
        requested.push(options);
        return options.status === activeStatus ? [{ id: "active-session" }] : [];
      }
    }
  };
}

function verifiedClient(state = {}) {
  return {
    dialect: "postgres",
    async query(sql) {
      if (/current_user/.test(sql)) {
        return [{ authenticated_user: "stockbot operator", database: "stockbot target" }];
      }
      if (/pg_stat_ssl/.test(sql)) return [{ ssl: true }];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async close() { state.closed = (state.closed || 0) + 1; }
  };
}

function serviceOptions(overrides = {}) {
  const repo = overrides.repositories ?? repositories();
  return {
    config: {
      databaseUrl: CURRENT_URL,
      databaseLocation: "remote",
      configFile: "/protected/stockbot.env",
      ...overrides.config
    },
    repositories: repo,
    clientFactory: overrides.clientFactory ?? (async () => verifiedClient()),
    initializeDatabase: overrides.initializeDatabase ?? (async () => ({
      migrations: { applied: ["0004"], skipped: ["0001", "0002", "0003"] },
      account: { id: "default-paper" },
      status: { healthy: true }
    })),
    configWriter: overrides.configWriter ?? (async () => {}),
    repo
  };
}

test("database profiles round-trip encoded credentials and a distinct connect address", () => {
  const input = profile({
    hostname: "postgres.example.test",
    connectAddress: "fd7a:115c:a1e0::b837:b054",
    database: "stocks / paper",
    username: "user@example.test",
    sslMode: "verify-full"
  });
  const url = buildDatabaseUrl(input);
  const parsed = parseDatabaseProfile(url, input.location);

  assert.deepEqual(parsed, input);
  assert.match(url, /^postgresql:\/\//);
  assert.match(url, /sslmode=verify-full/);
  assert.match(url, /hostaddr=fd7a%3A115c%3Aa1e0%3A%3Ab837%3Ab054/);
});

test("database profiles reject malformed hostnames without exposing credentials", () => {
  for (const invalidHostname of ["https://database.example", "bad host", "bad:port", "bad\"host", "bad\\host"]) {
    assert.throws(
      () => buildDatabaseUrl(profile({ hostname: invalidHostname })),
      (error) => error.code === "DATABASE_PROFILE_INVALID"
        && error.status === 400
        && !error.message.includes(profile().password)
    );
  }
});

test("database hostname accepts DNS and IP values but rejects URL punctuation", () => {
  assert.doesNotThrow(() => buildDatabaseUrl(profile({ hostname: "localhost" })));
  assert.doesNotThrow(() => buildDatabaseUrl(profile({ hostname: "db-1.internal.example" })));
  assert.doesNotThrow(() => buildDatabaseUrl(profile({ hostname: "2001:db8::1" })));
  for (const value of ["foo:bar", "bad\"host", "bad\\host", "https://db.example", "-db.example"]) {
    assert.throws(() => buildDatabaseUrl(profile({ hostname: value })), /Hostname/);
  }
});

test("environment updates preserve unrelated host configuration and remain dotenv-readable", () => {
  const replacementUrl = buildDatabaseUrl(profile());
  const source = [
    "# private host configuration",
    "export DATABASE_URL = 'postgresql://old:old@localhost/old'",
    "STOCKBOT_API_TOKEN='keep-api-token'",
    "STOCKBOT_SETTINGS_KEY='keep-settings-key'",
    ""
  ].join("\n");
  const output = updateEnvironmentSource(source, {
    DATABASE_URL: replacementUrl,
    STOCKBOT_DATABASE_LOCATION: "remote"
  });

  assert.match(output, /STOCKBOT_API_TOKEN='keep-api-token'/);
  assert.match(output, /STOCKBOT_SETTINGS_KEY='keep-settings-key'/);
  assert.equal(output.match(/DATABASE_URL/g)?.length, 1);
  assert.equal(output.match(/STOCKBOT_DATABASE_LOCATION/g)?.length, 1);
});

test("saved URL remains readable by Node env-file parsing when a password contains quotes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-node-env-file-"));
  const envFile = join(directory, "stockbot.env");
  try {
    const databaseUrl = buildDatabaseUrl(profile({ password: "single' and double\" quote" }));
    await writeFile(envFile, updateEnvironmentSource("", { DATABASE_URL: databaseUrl }), { mode: 0o600 });
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [`--env-file=${envFile}`, "-e", "process.stdout.write(process.env.DATABASE_URL || '')"], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, databaseUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public database settings are redacted and preserve a blank replacement password", async () => {
  let candidateUrl;
  const options = serviceOptions({
    clientFactory: async (url, poolOptions) => {
      candidateUrl = url;
      assert.deepEqual(poolOptions, { connectionTimeoutMs: 5_000, maxConnections: 1 });
      return verifiedClient();
    }
  });
  const service = createDatabaseSettingsService(options);

  const publicPayload = service.publicPayload();
  assert.equal(publicPayload.configuration.passwordConfigured, true);
  assert.equal("password" in publicPayload.configuration, false);
  assert.doesNotMatch(JSON.stringify(publicPayload), /current password/);

  const result = await service.test(profile({ password: "" }));
  assert.deepEqual(result, {
    ok: true,
    message: "PostgreSQL connection verified.",
    user: "stockbot operator",
    database: "stockbot target",
    tls: true
  });
  assert.equal(parseDatabaseProfile(candidateUrl).password, CURRENT_PASSWORD);
});

test("testing a database is non-mutating, closes its temporary pool, and sanitizes failures", async () => {
  const clientState = {};
  let initialized = 0;
  let written = 0;
  const service = createDatabaseSettingsService(serviceOptions({
    clientFactory: async () => verifiedClient(clientState),
    initializeDatabase: async () => { initialized += 1; },
    configWriter: async () => { written += 1; }
  }));

  await service.test(profile());
  assert.equal(clientState.closed, 1);
  assert.equal(initialized, 0);
  assert.equal(written, 0);

  const secret = profile().password;
  const failing = createDatabaseSettingsService(serviceOptions({
    clientFactory: async () => {
      const error = new Error(`authentication failed for ${secret}`);
      error.code = "28P01";
      throw error;
    }
  }));
  await assert.rejects(
    failing.test(profile()),
    (error) => error.code === "28P01"
      && error.status === 422
      && !error.message.includes(secret)
  );
});

test("saving validates and initializes before persisting, then reports a pending restart", async () => {
  const calls = [];
  const clientState = {};
  const service = createDatabaseSettingsService(serviceOptions({
    clientFactory: async (url) => {
      calls.push(["connect", parseDatabaseProfile(url).hostname]);
      return verifiedClient(clientState);
    },
    initializeDatabase: async () => {
      calls.push(["initialize"]);
      return {
        migrations: { applied: ["0004"], skipped: ["0001", "0002", "0003"] },
        account: { id: "default-paper" },
        status: { healthy: true }
      };
    },
    configWriter: async (path, url, location) => {
      calls.push(["write", path, parseDatabaseProfile(url).hostname, location]);
    }
  }));

  const result = await service.save(profile());
  assert.deepEqual(calls, [
    ["connect", "new-database.internal.example"],
    ["initialize"],
    ["write", "/protected/stockbot.env", "new-database.internal.example", "remote"]
  ]);
  assert.equal(clientState.closed, 1);
  assert.equal(result.restartRequired, true);
  assert.equal(result.configuration.passwordConfigured, true);
  assert.equal("password" in result.configuration, false);
  assert.equal(service.publicPayload().restartRequired, true);
});

test("a second save with a blank password preserves the most recently saved password", async () => {
  const urls = [];
  const service = createDatabaseSettingsService(serviceOptions({
    clientFactory: async (url) => {
      urls.push(url);
      return verifiedClient();
    }
  }));
  await service.save(profile({ password: "first replacement" }));
  await service.save(profile({ password: "", connectAddress: "10.20.30.41" }));
  assert.equal(parseDatabaseProfile(urls[1]).password, "first replacement");
});

test("identity mismatch is rejected before migrations or config writes", async () => {
  let initialized = 0;
  let written = 0;
  const service = createDatabaseSettingsService(serviceOptions({
    clientFactory: async () => ({
      dialect: "postgres",
      async query() { return [{ authenticated_user: "unexpected", database: "wrong" }]; },
      async close() {}
    }),
    initializeDatabase: async () => { initialized += 1; },
    configWriter: async () => { written += 1; }
  }));
  await assert.rejects(
    service.save(profile()),
    (error) => error.code === "DATABASE_IDENTITY_MISMATCH" && error.status === 422
  );
  assert.equal(initialized, 0);
  assert.equal(written, 0);
});

test("saving is blocked before connecting when a session is active", async () => {
  const repo = repositories("paused");
  let connections = 0;
  let writes = 0;
  const service = createDatabaseSettingsService(serviceOptions({
    repositories: repo,
    clientFactory: async () => { connections += 1; return verifiedClient(); },
    configWriter: async () => { writes += 1; }
  }));

  await assert.rejects(
    service.save(profile()),
    (error) => error.code === "DATABASE_CHANGE_ACTIVE_SESSIONS" && error.status === 409
  );
  assert.equal(connections, 0);
  assert.equal(writes, 0);
  assert.deepEqual(repo.requested.map((entry) => entry.status), ["arming", "running", "paused"]);
});

test("a failed connection or initializer never changes the protected host config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-database-settings-failure-"));
  const configFile = join(directory, "stockbot.env");
  const source = `DATABASE_URL=${JSON.stringify(CURRENT_URL)}\nSTOCKBOT_API_TOKEN=unchanged\n`;
  try {
    await writeFile(configFile, source, { mode: 0o600 });
    const service = createDatabaseSettingsService(serviceOptions({
      config: { configFile },
      clientFactory: async () => { throw new Error("connection unavailable"); }
    }));

    await assert.rejects(service.save(profile()), /could not be verified/);
    assert.equal(await readFile(configFile, "utf8"), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real protected config save is atomic, owner-only, and preserves other secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-database-settings-save-"));
  const configFile = join(directory, "stockbot.env");
  const source = [
    `DATABASE_URL=${JSON.stringify(CURRENT_URL)}`,
    "HOST=127.0.0.1",
    "STOCKBOT_API_TOKEN=keep-api-secret",
    "STOCKBOT_SETTINGS_KEY=keep-settings-secret",
    ""
  ].join("\n");
  try {
    await writeFile(configFile, source, { mode: 0o600 });
    const service = createDatabaseSettingsService({
      config: {
        databaseUrl: CURRENT_URL,
        databaseLocation: "remote",
        configFile
      },
      repositories: repositories(),
      clientFactory: async () => verifiedClient(),
      initializeDatabase: async () => ({
        migrations: { applied: [], skipped: ["0001", "0002", "0003"] },
        account: { id: "default-paper" },
        status: { healthy: true }
      })
    });
    await service.save(profile());

    const metadata = await stat(configFile);
    const environment = await configuredEnvironment(configFile);
    assert.equal(metadata.mode & 0o777, 0o600);
    assert.equal(environment.DATABASE_URL, buildDatabaseUrl(profile()));
    assert.equal(environment.STOCKBOT_DATABASE_LOCATION, "remote");
    assert.equal(environment.HOST, "127.0.0.1");
    assert.equal(environment.STOCKBOT_API_TOKEN, "keep-api-secret");
    assert.equal(environment.STOCKBOT_SETTINGS_KEY, "keep-settings-secret");

    await chmod(configFile, 0o644);
    await assert.rejects(
      configuredEnvironment(configFile),
      (error) => error.code === "DATABASE_CONFIG_PERMISSIONS" && error.status === 409
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed protected config write leaves the original bytes and restart state unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-database-settings-permissions-"));
  const configFile = join(directory, "stockbot.env");
  const source = `DATABASE_URL=${CURRENT_URL}\nSTOCKBOT_API_TOKEN=unchanged\n`;
  try {
    await writeFile(configFile, source, { mode: 0o644 });
    // The laptop installer runs tests under umask 077, so force the unsafe
    // fixture mode after creation instead of relying on the requested mode.
    await chmod(configFile, 0o644);
    const options = serviceOptions({ config: { configFile } });
    delete options.configWriter;
    const service = createDatabaseSettingsService(options);
    await assert.rejects(
      service.save(profile()),
      (error) => error.code === "DATABASE_CONFIG_PERMISSIONS" && error.status === 409
    );
    assert.equal(await readFile(configFile, "utf8"), source);
    assert.equal(service.publicPayload().restartRequired, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
