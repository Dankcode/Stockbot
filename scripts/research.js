#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseEnv } from "dotenv";

function cliError(message, code = "RESEARCH_CLI_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw cliError(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    if (rawName === "help") { options.help = true; continue; }
    const value = inline ?? tokens[++index];
    if (value == null || value.startsWith("--")) throw cliError(`--${rawName} requires a value.`);
    options[rawName.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value;
  }
  return { command, options };
}

async function environmentWithFile(environment, filename) {
  if (!filename) {
    try {
      return { ...parseEnv(await readFile(resolve(".env"), "utf8")), ...environment };
    } catch (error) {
      if (error?.code === "ENOENT") return environment;
      throw cliError("The project .env file cannot be read.", "ERR_ENV_FILE_INVALID");
    }
  }
  const path = resolve(filename);
  let metadata;
  try { metadata = await stat(path); }
  catch { throw cliError("The requested environment file cannot be read.", "ERR_ENV_FILE_NOT_FOUND"); }
  if (!metadata.isFile()) throw cliError("--env-file must identify a regular file.", "ERR_ENV_FILE_INVALID");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw cliError("The environment file must have owner-only permissions (chmod 600).", "ERR_ENV_FILE_PERMISSIONS");
  }
  return { ...parseEnv(await readFile(path, "utf8")), ...environment };
}

function usage() {
  return `Stockbot AI research CLI

Usage:
  npm run research -- adapters [--env-file PATH]
  npm run research -- validate --file PLAN.json [--env-file PATH]
  npm run research -- import --file PLAN.json [--env-file PATH]
  npm run research -- run --plan PLAN_ID --symbol SYMBOL [--version VERSION_ID] [--env-file PATH]
  npm run research -- list [--limit N] [--env-file PATH]
  npm run research -- show --run RUN_ID [--env-file PATH]
  npm run research -- snapshot --id SNAPSHOT_ID [--env-file PATH]

The CLI calls the loopback Stockbot API. It never executes a command named by
an imported plan and never sends the operator token to a remote host.
`;
}

function required(options, name) {
  const value = String(options[name] ?? "").trim();
  if (!value) throw cliError(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  return value;
}

async function apiRequest(fetchImpl, baseUrl, token, path, options = {}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      "x-stockbot-token": token,
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000)
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw cliError(`Stockbot API returned non-JSON HTTP ${response.status}.`, "RESEARCH_API_INVALID_RESPONSE"); }
  if (!response.ok || payload?.error) {
    throw cliError(payload?.error?.message ?? `Stockbot API returned HTTP ${response.status}.`, payload?.error?.code ?? "RESEARCH_API_ERROR");
  }
  return payload.data;
}

export async function runResearchCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const { command, options } = parseArguments(argv);
  if (!command || options.help) { stdout.write(usage()); return 0; }
  if (!["adapters", "validate", "import", "run", "list", "show", "snapshot"].includes(command)) {
    throw cliError(`Unknown research command: ${command}`);
  }
  const environment = await environmentWithFile(io.env ?? process.env, options.envFile);
  const token = String(environment.STOCKBOT_API_TOKEN ?? "");
  if (token.length < 32) throw cliError("STOCKBOT_API_TOKEN must be configured for the research CLI.", "AUTH_NOT_CONFIGURED");
  const port = Number(environment.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw cliError("PORT must be 1-65535.");
  const baseUrl = `http://127.0.0.1:${port}/`;
  const fetchImpl = io.fetch ?? fetch;
  let data;

  if (command === "adapters") {
    data = await apiRequest(fetchImpl, baseUrl, token, "/api/v1/research/adapters");
  } else if (command === "validate" || command === "import") {
    const filename = resolve(required(options, "file"));
    const source = await readFile(filename, "utf8");
    data = await apiRequest(
      fetchImpl,
      baseUrl,
      token,
      command === "validate" ? "/api/v1/research/plans/validate" : "/api/v1/research/plans",
      { method: "POST", body: { filename: filename.split(/[\\/]/).at(-1), source } }
    );
  } else if (command === "run") {
    const planId = encodeURIComponent(required(options, "plan"));
    data = await apiRequest(fetchImpl, baseUrl, token, `/api/v1/research/plans/${planId}/runs`, {
      method: "POST",
      body: {
        symbol: required(options, "symbol").toUpperCase(),
        ...(options.version ? { planVersionId: options.version } : {})
      },
      timeoutMs: 600_000
    });
  } else if (command === "list") {
    const limit = Number(options.limit ?? 50);
    data = await apiRequest(fetchImpl, baseUrl, token, `/api/v1/research/runs?limit=${encodeURIComponent(limit)}`);
  } else if (command === "show") {
    data = await apiRequest(fetchImpl, baseUrl, token, `/api/v1/research/runs/${encodeURIComponent(required(options, "run"))}`);
  } else {
    data = await apiRequest(fetchImpl, baseUrl, token, `/api/v1/research/snapshots/${encodeURIComponent(required(options, "id"))}`);
  }
  stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runResearchCli().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
