/**
 * The one way Stockbot launches Hermes. The research CLI and the swarm worker
 * both build their argv here, so the two cannot drift apart.
 *
 * Flags were verified against the installed Hermes CLI parser
 * (hermes-agent 0.20.5, commit 41447a6d7, hermes_cli/_parser.py `chat`
 * subparser; `--profile` is consumed before argparse by
 * main._apply_profile_override). `verifyHermesCli` re-checks them against the
 * binary that is actually on PATH before a run, so an upgrade that drops a
 * flag fails closed with a clear message instead of a silent argparse error.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const HERMES_VERIFIED = Object.freeze({
  version: "0.20.5",
  source: "hermes_cli/_parser.py@41447a6d7",
  chatFlags: Object.freeze([
    "--query-file", "--toolsets", "--max-turns", "--run-budget", "--quiet", "--ignore-rules", "--source"
  ]),
  preArgparseFlags: Object.freeze(["--profile"])
});

// The only toolsets a Stockbot launch may grant. An allowlist, not a denylist:
// research text is untrusted, and Hermes has many host-touching toolsets
// (terminal, file, code execution, cron, skills, debugging…).
export const ALLOWED_TOOLSETS = Object.freeze(["web", "delegation", "mcp-stockbot-agent"]);
const TOOLSET = /^[a-z][a-z0-9_-]{0,63}$/;
const PROFILE = /^[a-z][a-z0-9_-]{1,63}$/;

export class HermesError extends Error {
  constructor(message, code, detail = {}) {
    super(message);
    this.code = code;
    Object.assign(this, detail);
  }
}

export function buildHermesChatArgs({
  profile,
  queryFile,
  toolsets,
  maxTurns = 40,
  runBudgetSeconds = 900,
  ignoreRules = true,
  source = "tool"
}) {
  if (profile !== undefined && !PROFILE.test(String(profile))) throw new HermesError("Invalid Hermes profile name.", "HERMES_ARGS");
  if (typeof queryFile !== "string" || !queryFile) throw new HermesError("A query file is required.", "HERMES_ARGS");
  if (!Array.isArray(toolsets) || toolsets.length === 0) throw new HermesError("Name the toolsets explicitly.", "HERMES_ARGS");
  for (const toolset of toolsets) {
    if (!TOOLSET.test(toolset)) throw new HermesError(`Invalid toolset ${toolset}.`, "HERMES_ARGS");
    if (!ALLOWED_TOOLSETS.includes(toolset)) throw new HermesError(`Toolset ${toolset} is not allowed for Stockbot runs.`, "HERMES_TOOLSET_FORBIDDEN");
  }
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 200) throw new HermesError("maxTurns must be 1..200.", "HERMES_ARGS");
  if (!Number.isFinite(runBudgetSeconds) || runBudgetSeconds < 30 || runBudgetSeconds > 3_600) {
    throw new HermesError("runBudgetSeconds must be 30..3600.", "HERMES_ARGS");
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new HermesError("Invalid session source tag.", "HERMES_ARGS");
  return [
    ...(profile ? ["--profile", profile] : []),
    "chat",
    "--query-file", queryFile,
    "--toolsets", toolsets.join(","),
    "--max-turns", String(maxTurns),
    "--run-budget", String(runBudgetSeconds),
    "--quiet",
    ...(ignoreRules ? ["--ignore-rules"] : []),
    "--source", source
  ];
}

/** Flags our argv uses, for checking against `hermes chat --help`. */
export function flagsIn(args) {
  return [...new Set(args.filter((arg) => /^--[a-z][a-z-]*$/.test(arg)))];
}

export function parseHelpFlags(helpText) {
  return new Set(String(helpText).match(/--[a-z][a-z0-9-]*/g) ?? []);
}

/** Confirms every chat flag we pass exists in the installed binary's help. */
export async function verifyHermesCli({ bin = "hermes", run = exec, timeoutMs = 30_000 } = {}) {
  let help;
  try {
    help = (await run(bin, ["chat", "--help"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 })).stdout;
  } catch (error) {
    throw new HermesError(`Cannot run \`${bin} chat --help\` (${error.code ?? "failed"}). Is Hermes installed and on PATH?`, "HERMES_NOT_FOUND");
  }
  const available = parseHelpFlags(help);
  const missing = HERMES_VERIFIED.chatFlags.filter((flag) => !available.has(flag));
  if (missing.length) {
    throw new HermesError(
      `Installed Hermes does not support ${missing.join(", ")} (verified against ${HERMES_VERIFIED.version}). Update the launcher before running.`,
      "HERMES_FLAGS_UNSUPPORTED",
      { missing }
    );
  }
  return { ok: true, checked: [...HERMES_VERIFIED.chatFlags] };
}

const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const KEYED_SECRET = /(authorization|cookie|x-stockbot[a-z-]*token|api[_-]?key|access[_-]?key|auth[_-]?token|ct0|token|secret|password|passwd|pgpassword)(["'\s:=]+)(?:bearer\s+|basic\s+)?[^\s"';,]+/gi;
const BARE_SECRETS = [
  /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /sbat_[A-Za-z0-9_-]+/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /[A-Za-z0-9+_-]{40,}={0,2}/g // long opaque strings; slashes excluded so paths stay readable
];

export function redact(text) {
  let output = String(text ?? "").replace(URL_CREDENTIALS, "$1[redacted]@").replace(KEYED_SECRET, "$1$2[redacted]");
  for (const pattern of BARE_SECRETS) output = output.replace(pattern, "[redacted]");
  return output;
}

/**
 * The environment Hermes is launched with: enough to run, nothing that is a
 * Stockbot secret. The agent's own token reaches its MCP server through the
 * profile's STOCKBOT_AGENT_ENV file, not through this environment.
 */
const BASE_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|LANG|LC_[A-Z_]+|TZ|XDG_[A-Z_]+|HERMES_HOME)$/;
export function hermesEnvironment(source = process.env) {
  const passthrough = new Set(String(source.STOCKBOT_HERMES_ENV_PASSTHROUGH ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  return Object.fromEntries(Object.entries(source).filter(([name]) => BASE_ENV.test(name) || passthrough.has(name)));
}

export function stderrTail(stderr, lines = 20) {
  return redact(String(stderr ?? "").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n"));
}

export async function runHermes({ bin = "hermes", args, cwd, env = hermesEnvironment(), runBudgetSeconds = 900, run = exec }) {
  try {
    const result = await run(bin, args, {
      cwd,
      env,
      timeout: (runBudgetSeconds + 60) * 1_000,
      maxBuffer: 8 * 1024 * 1024
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    throw new HermesError(
      error.killed ? `Hermes exceeded its ${runBudgetSeconds}s budget and was stopped.` : `Hermes exited with ${error.code ?? "an error"}.`,
      error.killed ? "HERMES_TIMEOUT" : "HERMES_EXIT",
      { stderrTail: stderrTail(error.stderr) }
    );
  }
}
