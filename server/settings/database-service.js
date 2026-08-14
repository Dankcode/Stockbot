import { chmod, open, readFile, rename, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { parse as parseEnv } from "dotenv";

import { createClient } from "../db/client.js";
import { initializeDatabase } from "../db/operations.js";
import { AppError } from "../http/errors.js";

const ACTIVE_SESSION_STATUSES = Object.freeze(["arming", "running", "paused", "stopping"]);
const LOCATIONS = new Set(["local", "remote"]);
const TLS_MODES = new Set(["disable", "require", "verify-full"]);
const ENV_ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)/;

function inputError(message) {
  return new AppError("DATABASE_PROFILE_INVALID", message, 400);
}

function decodeUrlComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw inputError(`The PostgreSQL ${label} is not valid URL encoding.`);
  }
}

function hostname(value) {
  const normalized = String(value ?? "").trim().replace(/^\[|\]$/g, "");
  const ipFamily = isIP(normalized);
  const validDnsName = normalized.length <= 253
    && normalized.split(".").every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
    ));
  if (!normalized || (!ipFamily && !validDnsName)) {
    throw inputError("Hostname must be a hostname or IP address without a URL scheme.");
  }
  return normalized;
}

function boundedText(value, label, maximum = 128) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw inputError(`${label} is required and must contain at most ${maximum} characters.`);
  }
  return normalized;
}

function normalizeProfile(input, fallbackPassword = "") {
  const profile = input && typeof input === "object" ? input : {};
  const location = String(profile.location ?? "local");
  if (!LOCATIONS.has(location)) throw inputError("Location must be local or remote.");
  const connectAddress = String(profile.connectAddress ?? "").trim().replace(/^\[|\]$/g, "");
  if (connectAddress && !isIP(connectAddress)) {
    throw inputError("Connect address must be an IPv4 or IPv6 address.");
  }
  const port = Number(profile.port ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw inputError("Port must be an integer between 1 and 65535.");
  }
  const sslMode = String(profile.sslMode ?? "verify-full");
  if (!TLS_MODES.has(sslMode)) {
    throw inputError("TLS mode must be disable, require, or verify-full.");
  }
  const suppliedPassword = profile.password === undefined ? "" : String(profile.password);
  const password = suppliedPassword || fallbackPassword;
  if (!password || password.includes("\0")) throw inputError("A PostgreSQL password is required.");
  return {
    location,
    hostname: hostname(profile.hostname),
    connectAddress,
    port,
    database: boundedText(profile.database, "Database name"),
    username: boundedText(profile.username, "Username"),
    password,
    sslMode
  };
}

export function parseDatabaseProfile(databaseUrl, location = "local") {
  const value = String(databaseUrl ?? "").trim();
  if (!/^postgres(?:ql)?:\/\//i.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw inputError("The configured PostgreSQL URL is invalid.");
  }
  const sslMode = url.searchParams.get("sslmode") || "disable";
  if (!TLS_MODES.has(sslMode)) {
    throw inputError("The configured PostgreSQL TLS mode is unsupported by the settings editor.");
  }
  const connectAddress = url.searchParams.get("hostaddr")?.trim() || "";
  if (connectAddress && !isIP(connectAddress)) throw inputError("The configured connect address is invalid.");
  return normalizeProfile({
    location: LOCATIONS.has(location) ? location : "remote",
    hostname: url.hostname,
    connectAddress,
    port: url.port ? Number(url.port) : 5432,
    database: decodeUrlComponent(url.pathname.slice(1), "database name"),
    username: decodeUrlComponent(url.username, "username"),
    password: decodeUrlComponent(url.password, "password"),
    sslMode
  });
}

export function buildDatabaseUrl(input, fallbackPassword = "") {
  const profile = normalizeProfile(input, fallbackPassword);
  const host = isIP(profile.hostname) === 6 ? `[${profile.hostname}]` : profile.hostname;
  const url = new URL(`postgresql://${host}`);
  url.username = profile.username;
  url.password = profile.password;
  url.port = String(profile.port);
  url.pathname = `/${profile.database}`;
  url.searchParams.set("sslmode", profile.sslMode);
  if (profile.sslMode === "require") url.searchParams.set("uselibpqcompat", "true");
  if (profile.connectAddress) url.searchParams.set("hostaddr", profile.connectAddress);
  return url.toString();
}

function sanitized(profile) {
  if (!profile) return null;
  return {
    location: profile.location,
    hostname: profile.hostname,
    connectAddress: profile.connectAddress,
    port: profile.port,
    database: profile.database,
    username: profile.username,
    sslMode: profile.sslMode,
    passwordConfigured: Boolean(profile.password)
  };
}

function environmentValue(value) {
  const normalized = String(value);
  if (/[\r\n\0]/.test(normalized)) {
    throw inputError("Environment configuration values cannot contain line breaks.");
  }
  return normalized;
}

export function updateEnvironmentSource(source, replacements) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const values = new Map(Object.entries(replacements));
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(ENV_ASSIGNMENT);
    if (!match || !values.has(match[2])) continue;
    lines[index] = `${match[1]}${match[2]}${match[3]}${environmentValue(values.get(match[2]))}`;
    seen.add(match[2]);
  }
  const appendAt = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  lines.splice(
    appendAt,
    0,
    ...[...values].filter(([key]) => !seen.has(key)).map(([key, value]) => `${key}=${environmentValue(value)}`)
  );
  return lines.join(newline);
}

async function assertProtectedConfig(path) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new AppError("DATABASE_CONFIG_UNAVAILABLE", "The protected Stockbot config file is unavailable.", 409);
  }
  if (!metadata.isFile() || (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600)) {
    throw new AppError("DATABASE_CONFIG_PERMISSIONS", "The Stockbot config file must be a regular owner-only file (mode 0600).", 409);
  }
}

async function writeConfig(path, databaseUrl, location) {
  await assertProtectedConfig(path);
  const source = await readFile(path, "utf8");
  const output = updateEnvironmentSource(source, {
    DATABASE_URL: databaseUrl,
    STOCKBOT_DATABASE_LOCATION: location
  });
  const temporary = resolve(dirname(path), `.stockbot.env.${process.pid}.${Date.now()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(output, "utf8");
    await file.sync();
    await file.close();
    file = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await file?.close().catch(() => undefined);
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function safeConnectionError(error) {
  if (error instanceof AppError) return error;
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : "DATABASE_CONNECTION_FAILED";
  return new AppError(code, "The PostgreSQL connection could not be verified.", 422);
}

export function createDatabaseSettingsService(options = {}) {
  const config = options.config;
  const repositories = options.repositories;
  const clientFactory = options.clientFactory ?? createClient;
  const initializer = options.initializeDatabase ?? initializeDatabase;
  const configWriter = options.configWriter ?? writeConfig;
  if (!config || !repositories?.sessions) {
    throw new TypeError("createDatabaseSettingsService requires config and session repositories.");
  }
  const active = parseDatabaseProfile(config.databaseUrl, config.databaseLocation);
  let saved = active;
  let restartRequired = false;

  function publicPayload() {
    return {
      configuration: sanitized(saved),
      active: active ? {
        dialect: "postgres",
        hostname: active.hostname,
        connectAddress: active.connectAddress,
        port: active.port,
        database: active.database,
        username: active.username,
        sslMode: active.sslMode
      } : { dialect: "sqlite" },
      restartRequired
    };
  }

  function candidate(input) {
    if (!saved && !input?.password) throw inputError("A PostgreSQL password is required.");
    return normalizeProfile(input, saved?.password || "");
  }

  async function verify(profile, { initialize = false } = {}) {
    let client;
    try {
      client = await clientFactory(buildDatabaseUrl(profile), {
        connectionTimeoutMs: 5_000,
        maxConnections: 1
      });
      const [identity] = await client.query(
        "SELECT current_user AS authenticated_user, current_database() AS database"
      );
      if (identity?.authenticated_user !== profile.username || identity?.database !== profile.database) {
        throw new AppError("DATABASE_IDENTITY_MISMATCH", "PostgreSQL connected with an unexpected user or database.", 422);
      }
      let tls = false;
      if (client.dialect === "postgres") {
        try {
          const [row] = await client.query(
            "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
          );
          tls = Boolean(row?.ssl);
        } catch {
          tls = profile.sslMode !== "disable";
        }
      }
      const initialized = initialize ? await initializer(client) : null;
      return { identity, tls, initialized };
    } catch (error) {
      throw safeConnectionError(error);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async function test(input) {
    const profile = candidate(input);
    const result = await verify(profile);
    return {
      ok: true,
      message: "PostgreSQL connection verified.",
      user: result.identity?.authenticated_user ?? profile.username,
      database: result.identity?.database ?? profile.database,
      tls: result.tls
    };
  }

  async function save(input) {
    if (!config.configFile) {
      throw new AppError("DATABASE_CONFIG_UNAVAILABLE", "Database settings require STOCKBOT_CONFIG_FILE.", 409);
    }
    for (const status of ACTIVE_SESSION_STATUSES) {
      if ((await repositories.sessions.list({ status, limit: 1 })).length) {
        throw new AppError("DATABASE_CHANGE_ACTIVE_SESSIONS", "Stop all active sessions before changing the database.", 409);
      }
    }
    const profile = candidate(input);
    const result = await verify(profile, { initialize: true });
    const databaseUrl = buildDatabaseUrl(profile);
    await configWriter(resolve(config.configFile), databaseUrl, profile.location);
    saved = profile;
    restartRequired = true;
    return publicPayload();
  }

  return Object.freeze({ publicPayload, test, save });
}

export async function configuredEnvironment(path) {
  await assertProtectedConfig(path);
  return parseEnv(await readFile(path, "utf8"));
}
