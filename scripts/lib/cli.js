/**
 * Shared CLI plumbing.
 *
 * `scripts/research.js`, `scripts/plugin.js` and `scripts/horizon-matrix.js` each carry
 * their own copy of flag parsing, env-file loading and the loopback API client — three
 * implementations of the same forty lines, with the permission check and the
 * "process.env overrides the file" rule restated in each. A fourth CLI was the point at
 * which that stopped being acceptable, so it lives here once.
 *
 * The env-file semantics are deliberately preserved exactly as documented in docs/CLI.md,
 * because they are load-bearing for the production config:
 *
 *   - the file must be a regular file with owner-only (0600) permissions
 *   - real process environment variables override file values, never the reverse
 *   - with no --env-file, the project .env is read and then overlaid with process.env
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { parse as parseEnv } from "dotenv";

export function cliError(message, code = "CLI_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Parses `--name value` and `--name=value`. `booleans` are flags that take no value;
 * `repeatable` collect into arrays so `--strategy a --strategy b` works, which is what
 * an experiment needs and what a plain key/value parser silently gets wrong by keeping
 * only the last one.
 */
export function parseFlags(argv, { booleans = [], repeatable = [], errorCode = "CLI_ERROR" } = {}) {
  const booleanSet = new Set([...booleans, "help"]);
  const repeatableSet = new Set(repeatable);
  const flags = Object.create(null);
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (booleanSet.has(name)) {
      if (inline !== undefined) throw cliError(`--${name} does not take a value.`, errorCode);
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith("--")) {
      throw cliError(`--${name} requires a value.`, errorCode);
    }
    if (repeatableSet.has(name)) (flags[name] ??= []).push(String(value));
    else flags[name] = String(value);
  }
  return { flags, positional };
}

/** Splits a repeatable flag that also accepts comma-separated values. */
export function listFlag(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((entry) => String(entry).split(",")).map((entry) => entry.trim()).filter(Boolean);
}

export async function loadEnvironment(envFile, root) {
  if (!envFile) {
    try {
      return { ...parseEnv(await readFile(path.resolve(root, ".env"), "utf8")), ...process.env };
    } catch (error) {
      if (error?.code === "ENOENT") return process.env;
      throw cliError("The project .env file cannot be read.", "ERR_ENV_FILE_INVALID");
    }
  }
  const resolved = path.resolve(envFile);
  let metadata;
  try {
    metadata = await stat(resolved);
  } catch {
    throw cliError("The requested environment file cannot be read.", "ERR_ENV_FILE_NOT_FOUND");
  }
  if (!metadata.isFile()) throw cliError("--env-file must identify a regular file.", "ERR_ENV_FILE_INVALID");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw cliError("The environment file must have owner-only permissions (chmod 600).", "ERR_ENV_FILE_PERMISSIONS");
  }
  return { ...parseEnv(await readFile(resolved, "utf8")), ...process.env };
}

/**
 * Loopback API client. The token is sent only to 127.0.0.1 — the base URL is constructed
 * here from PORT rather than accepted from a caller, so no flag or config value can
 * redirect an operator credential to a remote host.
 */
export function createApiClient(environment, { errorCode = "API_ERROR", timeoutMs = 180_000 } = {}) {
  const token = String(environment.STOCKBOT_API_TOKEN ?? "");
  if (token.length < 32) {
    throw cliError(
      "STOCKBOT_API_TOKEN must be configured (32+ characters) before this command can reach the API.",
      "AUTH_NOT_CONFIGURED"
    );
  }
  const port = Number(environment.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw cliError("PORT must be 1-65535.", errorCode);
  const baseUrl = `http://127.0.0.1:${port}/`;

  async function request(method, route, body) {
    const response = await fetch(new URL(`/api/v1${route}`, baseUrl), {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-stockbot-token": token
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw cliError(
        `Stockbot API returned non-JSON HTTP ${response.status}. Is the server running on port ${port}?`,
        `${errorCode}_INVALID_RESPONSE`
      );
    }
    if (!response.ok || payload?.error) {
      throw cliError(payload?.error?.message ?? `Stockbot API returned HTTP ${response.status}.`, payload?.error?.code ?? errorCode);
    }
    return payload.data;
  }

  return {
    baseUrl,
    token,
    get: (route) => request("GET", route),
    post: (route, body) => request("POST", route, body ?? {})
  };
}

/** Consistent `CODE: message` on stderr and a non-zero exit, matching the other CLIs. */
export function runMain(main) {
  main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
      process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}\n`);
      process.exit(1);
    }
  );
}
