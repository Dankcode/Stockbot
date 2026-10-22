import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createApi } from "../../scripts/mcp/stockbot-mcp.js";
import { createAgentApi, loadAgentConfig } from "../../scripts/mcp/stockbot-agent-mcp.js";
import { OPERATOR_TOKEN, PLAN, bootStockbot, fixtureMarket } from "./fixture.js";

const FAKE_HERMES = path.resolve("scripts/dev/fake-hermes.js");

async function setup(t) {
  const scratch = await mkdtemp(path.join(tmpdir(), "stockbot-worker-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = {
    STOCKBOT_AGENTS_DIR: path.join(scratch, "agents"),
    STOCKBOT_SWARM_RUN_DIR: path.join(scratch, "runs"),
    STOCKBOT_HERMES_BIN: FAKE_HERMES,
    FAKE_HERMES_AGENT: path.resolve("scripts/dev/fake-agent.js"),
    FAKE_AGENT_MCP: path.resolve("scripts/mcp/stockbot-agent-mcp.js"),
    FAKE_HERMES_RECORD: path.join(scratch, "hermes-call.json"),
    FAKE_AGENT_TRANSCRIPT: path.join(scratch, "transcript.json"),
    STOCKBOT_HERMES_ENV_PASSTHROUGH: "FAKE_HERMES_MODE,FAKE_HERMES_AGENT,FAKE_AGENT_MCP,FAKE_HERMES_RECORD,FAKE_AGENT_TRANSCRIPT,FAKE_AGENT_ENV,FAKE_HERMES_DROP_FLAG",
    // Present in the worker's environment; must not reach Hermes.
    STOCKBOT_API_TOKEN: "operator-secret-that-must-not-reach-hermes-000000",
    DATABASE_URL: "postgres://app:db-password@127.0.0.1/stockbot"
  };
  const saved = Object.fromEntries(Object.keys({ ...env, FAKE_HERMES_MODE: 1, FAKE_AGENT_ENV: 1 }).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : (process.env[key] = value); });
  const hub = await bootStockbot(t, { market: fixtureMarket({ provider: "alpaca" }) });
  const bridge = { baseUrl: `${hub.baseUrl}/`, token: OPERATOR_TOKEN };
  const planFile = path.join(scratch, "plan.json");
  await writeFile(planFile, JSON.stringify(PLAN));
  // Imported after the env is set: the CLI resolves its agents directory at load time.
  const cli = await import(`../../scripts/swarm/agent.js?${Date.now()}`);
  const worker = await import("../../scripts/swarm/worker.js");
  const quiet = () => {};
  return { hub, bridge, planFile, cli, worker, scratch, env, quiet, operator: createApi(bridge) };
}

test("end to end, orders off: scheduled task → scoped Hermes worker → Stockbot retrieval → SQL report → attributed HOLD → completed", async (t) => {
  const s = await setup(t);
  const created = await s.cli.run(["create", "alpha", "--plan", s.planFile], { api: s.operator, bridge: s.bridge, log: s.quiet });
  const envFile = path.join(s.env.STOCKBOT_AGENTS_DIR, `${created.hermesProfile}.env`);
  assert.equal((await stat(envFile)).mode & 0o777, 0o600, "the agent token file is owner-only");
  assert.equal((await stat(s.env.STOCKBOT_AGENTS_DIR)).mode & 0o777, 0o700);
  assert.match(await readFile(envFile, "utf8"), /STOCKBOT_AGENT_TOKEN=sbat_/);
  const setupCommands = s.cli.hermesSetupCommands({ profile: "sb-alpha", envFile: "/e", mcpScript: "/m.js" });
  assert.equal(setupCommands[0], "hermes profile create sb-alpha --clone");
  assert.match(setupCommands[1], /mcp add stockbot-agent .*--env STOCKBOT_AGENT_ENV=\/e --args \/m\.js$/);
  assert.doesNotMatch(setupCommands.join("\n"), /sbat_/, "no token in the setup commands");

  assert.equal((await s.cli.run(["tick"], { api: s.operator, bridge: s.bridge, log: s.quiet })).created, 1);
  process.env.FAKE_HERMES_MODE = "agent";
  process.env.FAKE_AGENT_ENV = envFile;
  const api = createAgentApi(await loadAgentConfig({ STOCKBOT_AGENT_ENV: envFile }));
  const result = await s.worker.runOnce({ api, profile: created.hermesProfile, log: s.quiet });

  assert.equal(result.outcome, "completed", result.reason);
  assert.deepEqual(result.decisions.map(({ symbol, action }) => [symbol, action]).sort(), [["QQQ", "hold"], ["SPY", "hold"]]);
  assert.deepEqual(result.provenance.providers, ["alpaca"]);
  assert.equal(result.provenance.receiptCount, 4);

  // Hermes was launched scoped: its own profile, only the Stockbot MCP toolset, inside the run directory.
  const call = JSON.parse(await readFile(s.env.FAKE_HERMES_RECORD, "utf8"));
  assert.equal(call.parsed.profile, "sb-alpha");
  assert.equal(call.parsed["--toolsets"], "mcp-stockbot-agent");
  assert.equal(call.parsed["--ignore-rules"], true);
  assert.equal(call.cwd, result.directory);
  for (const secret of ["STOCKBOT_API_TOKEN", "DATABASE_URL", "STOCKBOT_SETTINGS_KEY", "ALPACA_API_SECRET"]) {
    assert.ok(!call.envKeys.includes(secret), `${secret} is not passed to Hermes`);
  }
  const transcript = JSON.parse(await readFile(s.env.FAKE_AGENT_TRANSCRIPT, "utf8"));
  assert.deepEqual(transcript[0].tools, ["current_task", "retrieve", "portfolio", "submit_report", "submit_intent", "fail_task"]);
  assert.equal(transcript[1].ordersEnabled, false);

  // The persisted chain, from SQL.
  const { client } = s.hub.runtime;
  const rows = await client.query(
    `SELECT t.created_by, t.status AS task_status, d.symbol, d.action, d.agent_id, r.id AS report_id,
            (SELECT COUNT(*) FROM report_evidence e WHERE e.report_id = r.id) AS evidence,
            (SELECT COUNT(*) FROM retrieval_receipts x WHERE x.task_id = t.id AND x.provider = 'alpaca') AS receipts
       FROM agent_tasks t JOIN agent_reports r ON r.task_id = t.id JOIN agent_decisions d ON d.report_id = r.id
      WHERE t.id = ? ORDER BY d.symbol`,
    [result.taskId]
  );
  assert.deepEqual(rows.map((row) => [row.created_by, row.task_status, row.symbol, row.action, row.agent_id, Number(row.evidence), Number(row.receipts)]), [
    ["scheduler", "completed", "QQQ", "hold", "agent-alpha", 4, 4],
    ["scheduler", "completed", "SPY", "hold", "agent-alpha", 4, 4]
  ]);
  assert.equal(Number((await client.query("SELECT COUNT(*) AS n FROM orders"))[0].n), 0);
  assert.equal(Number((await client.query("SELECT COUNT(*) AS n FROM agent_intents"))[0].n), 0);
  assert.equal(Number((await client.query("SELECT COUNT(*) AS n FROM sessions"))[0].n), 0, "the swarm never touches strategy sessions");
});

test("a Hermes run that ends without a report fails the task visibly", async (t) => {
  const s = await setup(t);
  const created = await s.cli.run(["create", "alpha", "--plan", s.planFile], { api: s.operator, bridge: s.bridge, log: s.quiet });
  const envFile = path.join(s.env.STOCKBOT_AGENTS_DIR, `${created.hermesProfile}.env`);
  const api = createAgentApi(await loadAgentConfig({ STOCKBOT_AGENT_ENV: envFile }));
  await s.cli.run(["task", "alpha"], { api: s.operator, bridge: s.bridge, log: s.quiet });
  process.env.FAKE_HERMES_MODE = "report"; // prints text, never calls a tool
  const silent = await s.worker.runOnce({ api, profile: created.hermesProfile, log: s.quiet });
  assert.equal(silent.outcome, "failed");
  const detail = await s.operator.get("/swarm/agents/agent-alpha");
  assert.deepEqual([detail.tasks[0].status, detail.tasks[0].errorCode], ["failed", "no_report"]);

  await s.cli.run(["task", "alpha"], { api: s.operator, bridge: s.bridge, log: s.quiet });
  process.env.FAKE_HERMES_MODE = "fail";
  const crashed = await s.worker.runOnce({ api, profile: created.hermesProfile, log: s.quiet });
  assert.equal(crashed.outcome, "failed");
  const after = await s.operator.get("/swarm/agents/agent-alpha");
  const failed = after.tasks.find((task) => task.id === crashed.taskId);
  assert.equal(failed.errorCode, "HERMES_EXIT");
  assert.match(failed.errorDetail, /provider error/);
  assert.doesNotMatch(failed.errorDetail, /fakefakefake/, "Hermes stderr is redacted before it is stored");

  assert.equal((await s.worker.runOnce({ api, profile: created.hermesProfile, log: s.quiet })).outcome, "idle");
});

test("`npm run swarm -- prove <agent>` runs one full cycle and prints the persisted chain", async (t) => {
  const s = await setup(t);
  const created = await s.cli.run(["create", "alpha", "--plan", s.planFile], { api: s.operator, bridge: s.bridge, log: s.quiet });
  process.env.FAKE_HERMES_MODE = "agent";
  process.env.FAKE_AGENT_ENV = path.join(s.env.STOCKBOT_AGENTS_DIR, `${created.hermesProfile}.env`);
  const proof = await s.cli.run(["prove", "alpha"], { api: s.operator, bridge: s.bridge, log: s.quiet });
  assert.equal(proof.outcome, "completed");
  assert.equal(proof.chain.task.status, "completed");
  assert.equal(proof.chain.task.createdBy, "operator");
  assert.equal(proof.chain.ordersEnabled, false);
  assert.equal(proof.chain.intents, 0);
  assert.deepEqual(proof.chain.decisions.map((decision) => decision.action), ["hold", "hold"]);
  assert.deepEqual(proof.chain.report.provenance.providers, ["alpaca"]);
});
