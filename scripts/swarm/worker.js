#!/usr/bin/env node
/**
 * Runs ONE due research task for ONE agent through its own Hermes profile.
 *
 *   node scripts/swarm/worker.js --profile sb-alpha [--env ~/.config/stockbot/agents/alpha.env] [--task <id>]
 *
 * The worker claims the task, writes the prompt, and launches Hermes with only
 * the profile's `mcp-stockbot-agent` toolset (the `stockbot-agent` MCP server) (no web, file or terminal tools): the
 * agent can only act through Stockbot's agent API. Afterwards the worker asks
 * Stockbot, not Hermes, whether a report was recorded. A run that ends without
 * a report fails the task visibly; nothing is retried silently.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildHermesChatArgs, runHermes, verifyHermesCli } from "../lib/hermes.js";
import { createAgentApi, loadAgentConfig } from "../mcp/stockbot-agent-mcp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const WORKER_TOOLSETS = Object.freeze(["mcp-stockbot-agent"]);
const MAX_TURNS = 30;
const RUN_BUDGET_SECONDS = 600;

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--profile", "--env", "--task"].includes(flag) || value === undefined) {
      throw new Error("Usage: node scripts/swarm/worker.js --profile <hermes-profile> [--env <agent env file>] [--task <task id>]");
    }
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (!options.profile) throw new Error("--profile is required.");
  return options;
}

export async function buildPrompt({ task, plan }) {
  const mandate = await readFile(path.join(root, "research/agents/swarm-agent-mandate.md"), "utf8");
  return `${mandate}\n\n## This task\n\n` +
    "```json\n" + JSON.stringify({
      taskId: task.id,
      dueAt: new Date(task.dueAt).toISOString(),
      leaseExpiresAt: new Date(task.leaseExpiresAt).toISOString(),
      plan: { name: plan.name, version: plan.version, universe: plan.universe, sources: plan.sources, decision: plan.decision }
    }, null, 2) + "\n```\n";
}

export async function runOnce({
  api,
  profile,
  taskId,
  hermesBin = process.env.STOCKBOT_HERMES_BIN || "hermes",
  runRoot = process.env.STOCKBOT_SWARM_RUN_DIR || path.join(os.homedir(), ".local", "state", "stockbot-swarm"),
  verify = verifyHermesCli,
  launch = runHermes,
  log = (line) => process.stdout.write(`${line}\n`)
}) {
  const me = await api.get("/me");
  if (me.status !== "active") return { outcome: "skipped", reason: `agent is ${me.status}` };
  let task;
  if (taskId) {
    task = (await api.get(`/tasks/${encodeURIComponent(taskId)}`)).task;
  } else {
    const due = (await api.get("/tasks?status=pending")).filter((entry) => entry.dueAt <= Date.now() && entry.expiresAt > Date.now());
    task = due.sort((left, right) => left.dueAt - right.dueAt)[0];
  }
  if (!task) return { outcome: "idle", reason: "no due task" };

  await verify({ bin: hermesBin });
  const { task: claimed, plan } = await api.post(`/tasks/${encodeURIComponent(task.id)}/claim`);
  log(`Claimed ${claimed.id} for ${me.name} (plan v${plan.version}, ${plan.universe.symbols.length} symbols).`);

  const directory = path.join(runRoot, profile, claimed.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const promptFile = path.join(directory, "prompt.md");
  await writeFile(promptFile, await buildPrompt({ task: claimed, plan }), { mode: 0o600 });
  const args = buildHermesChatArgs({ profile, queryFile: promptFile, toolsets: [...WORKER_TOOLSETS], maxTurns: MAX_TURNS, runBudgetSeconds: RUN_BUDGET_SECONDS });

  let hermesOutput = "";
  try {
    const result = await launch({ bin: hermesBin, args, cwd: directory, runBudgetSeconds: RUN_BUDGET_SECONDS });
    hermesOutput = result.stdout ?? "";
    await writeFile(path.join(directory, "hermes-output.md"), hermesOutput, { mode: 0o600 });
  } catch (error) {
    const detail = `${error.message}${error.stderrTail ? `\n${error.stderrTail}` : ""}`;
    await api.post(`/tasks/${encodeURIComponent(claimed.id)}/fail`, { code: String(error.code ?? "HERMES_EXIT").slice(0, 64), detail: detail.slice(0, 2_000) }).catch(() => undefined);
    return { outcome: "failed", taskId: claimed.id, reason: detail, directory };
  }

  // Stockbot is the source of truth for whether the cycle happened.
  const after = await api.get(`/tasks/${encodeURIComponent(claimed.id)}`);
  if (after.task.status !== "completed") {
    if (after.task.status === "claimed") {
      await api.post(`/tasks/${encodeURIComponent(claimed.id)}/fail`, { code: "no_report", detail: "Hermes exited without submitting a report." });
    }
    return { outcome: "failed", taskId: claimed.id, reason: `task is ${after.task.status} with no report`, directory };
  }
  return {
    outcome: "completed",
    taskId: claimed.id,
    reportId: after.report.id,
    provenance: after.report.provenanceJson,
    decisions: after.decisions.map(({ id, symbol, action, score }) => ({ id, symbol, action, score })),
    directory
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envFile = options.env ?? process.env.STOCKBOT_AGENT_ENV ?? path.join(os.homedir(), ".config", "stockbot", "agents", `${options.profile}.env`);
  const api = createAgentApi(await loadAgentConfig({ STOCKBOT_AGENT_ENV: envFile }));
  const result = await runOnce({ api, profile: options.profile, taskId: options.task });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome === "failed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
