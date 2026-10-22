import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";

import { ALLOWED_TOOLSETS, HERMES_VERIFIED, buildHermesChatArgs, flagsIn, hermesEnvironment, redact, verifyHermesCli } from "../../scripts/lib/hermes.js";

const exec = promisify(execFile);
const SWARM_ARGS = { profile: "sb-alpha", queryFile: "/run/prompt.md", toolsets: ["mcp-stockbot-agent"], maxTurns: 30, runBudgetSeconds: 600 };

test("the shared launcher builds one verified argv for every caller", () => {
  assert.deepEqual(buildHermesChatArgs(SWARM_ARGS), [
    "--profile", "sb-alpha", "chat", "--query-file", "/run/prompt.md", "--toolsets", "mcp-stockbot-agent",
    "--max-turns", "30", "--run-budget", "600", "--quiet", "--ignore-rules", "--source", "tool"
  ]);
  const used = flagsIn(buildHermesChatArgs(SWARM_ARGS));
  for (const flag of used) {
    assert.ok([...HERMES_VERIFIED.chatFlags, ...HERMES_VERIFIED.preArgparseFlags].includes(flag), `${flag} is verified`);
  }
});

test("host-touching toolsets and malformed arguments are refused", () => {
  for (const toolset of ["file", "terminal", "all", "*", "code_execution", "hermes-cli", "debugging", "development", "cronjob", "skills", "mcp-stockbot"]) {
    assert.throws(() => buildHermesChatArgs({ ...SWARM_ARGS, toolsets: [toolset] }), { code: /HERMES_(TOOLSET_FORBIDDEN|ARGS)/ });
  }
  assert.throws(() => buildHermesChatArgs({ ...SWARM_ARGS, profile: "../default" }), { code: "HERMES_ARGS" });
  assert.throws(() => buildHermesChatArgs({ ...SWARM_ARGS, toolsets: ["web,file"] }), { code: "HERMES_ARGS" });
  assert.throws(() => buildHermesChatArgs({ ...SWARM_ARGS, runBudgetSeconds: 99_999 }), { code: "HERMES_ARGS" });
});

test("verifyHermesCli fails closed when the installed binary lacks a flag", async () => {
  const help = (text) => async () => ({ stdout: text });
  const full = HERMES_VERIFIED.chatFlags.join(" ");
  assert.equal((await verifyHermesCli({ run: help(full) })).ok, true);
  await assert.rejects(verifyHermesCli({ run: help(full.replace("--run-budget", "")) }), { code: "HERMES_FLAGS_UNSUPPORTED", missing: ["--run-budget"] });
  await assert.rejects(verifyHermesCli({ run: async () => { const error = new Error("nope"); error.code = "ENOENT"; throw error; } }), { code: "HERMES_NOT_FOUND" });
});

test("launch toolsets come from an allowlist and the Hermes environment carries no Stockbot secrets", () => {
  assert.deepEqual([...ALLOWED_TOOLSETS], ["web", "delegation", "mcp-stockbot-agent"]);
  const env = hermesEnvironment({
    PATH: "/bin", HOME: "/h", LANG: "en_US.UTF-8", XDG_CONFIG_HOME: "/x", STOCKBOT_API_TOKEN: "t", DATABASE_URL: "postgres://u:p@h/d",
    STOCKBOT_SETTINGS_KEY: "k", ALPACA_API_SECRET: "s", OPENAI_API_KEY: "o", FAKE_X: "1", STOCKBOT_HERMES_ENV_PASSTHROUGH: "FAKE_X"
  });
  assert.deepEqual(Object.keys(env).sort(), ["FAKE_X", "HOME", "LANG", "PATH", "XDG_CONFIG_HOME"]);
});

test("redaction covers URL passwords, bearer tokens, cookies and common key formats", () => {
  // Every value here is fake. They are assembled at runtime so no credential-shaped
  // literal sits in this public repo (the pre-commit hook and GitHub secret
  // scanning look for those), while redact() still sees the real shapes.
  const fake = {
    password: ["FAKE", "pw", "only4test"].join("-"),
    bearer: ["fake", "bearer", "value"].join("."),
    cookie: ["fake", "ct0", "cookie"].join("_"),
    session: ["fake", "auth", "token"].join("_"),
    aws: ["AK", "IA", "FAKEFAKEFAKEFAKE"].join(""),
    slack: ["xo", "xb", "-0000-0000-fakefake"].join("")
  };
  const url = ["postgres://app", fake.password].join(":") + "@db:5432/stockbot";
  const text = redact(`pg_restore --dbname ${url} Bearer ${fake.bearer} ct0=${fake.cookie}; auth_token=${fake.session} ${fake.aws} ${fake.slack}`);
  for (const [kind, secret] of Object.entries(fake)) assert.ok(!text.includes(secret), `${kind} is redacted`);
  assert.match(text, /postgres:\/\/app:\[redacted\]@db:5432\/stockbot/);
});

test("stderr redaction removes tokens and keys but keeps paths readable", () => {
  const openaiShaped = ["sk", "proj", "fakefakefakefake"].join("-");
  const text = redact("token=abc Authorization: Bearer xyz sbat_" + "A".repeat(43) + ` ${openaiShaped} /Users/x/.hermes/hermes-agent/agent/very/long/path.py`);
  assert.doesNotMatch(text, /abc|xyz|sbat_A|sk-proj/);
  assert.match(text, /\/Users\/x\/\.hermes\/hermes-agent\/agent\/very\/long\/path\.py/);
});

// Optional: parse our argv with the real Hermes parser when its source is available
// (STOCKBOT_HERMES_SOURCE=/path/to/hermes-agent). This is how the flag list was verified.
const source = process.env.STOCKBOT_HERMES_SOURCE;
test("the argv parses with the installed Hermes argparse surface", { skip: !source || !existsSync(`${source}/hermes_cli/_parser.py`) }, async () => {
  const args = buildHermesChatArgs(SWARM_ARGS).slice(2); // --profile is consumed before argparse
  const script = `import sys,json; sys.path.insert(0, sys.argv[1]); from hermes_cli._parser import build_top_level_parser
p=build_top_level_parser()[0]; ns=vars(p.parse_args(sys.argv[2:])); print(json.dumps({k: ns[k] for k in ["command","query_file","toolsets","max_turns","run_budget","quiet","ignore_rules","source"]}))`;
  const { stdout } = await exec("python3", ["-c", script, source, ...args]);
  assert.deepEqual(JSON.parse(stdout), {
    command: "chat", query_file: "/run/prompt.md", toolsets: "mcp-stockbot-agent", max_turns: 30, run_budget: 600, quiet: true, ignore_rules: true, source: "tool"
  });
});
