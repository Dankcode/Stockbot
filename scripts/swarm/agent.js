#!/usr/bin/env node
/**
 * Operator CLI for the agent swarm. Talks to Stockbot's operator API with the
 * operator token from ~/.config/stockbot/mcp.env (or STOCKBOT_MCP_ENV), the
 * same 0600 file the operator MCP bridge uses.
 *
 *   npm run swarm -- create alpha [--plan research/agents/first-agent-plan.json]
 *   npm run swarm -- prove alpha          one cycle now: task → Hermes → report → HOLD/BUY/SELL
 *   npm run swarm -- show alpha
 *   npm run swarm -- task alpha           queue a task due now
 *   npm run swarm -- plan alpha <file>
 *   npm run swarm -- status alpha paused|active|halted|retired
 *   npm run swarm -- orders alpha on|off  per-agent order switch
 *   npm run swarm -- orders swarm on|off  global order switch (both must be on)
 *   npm run swarm -- token alpha          rotate the agent token (rewrites its env file)
 *   npm run swarm -- tick                 run one scheduler pass now
 *
 * Agent tokens are written only to ~/.config/stockbot/agents/<profile>.env
 * (0600) and are never printed.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createApi, loadBridgeConfig } from "../mcp/stockbot-mcp.js";
import { createAgentApi } from "../mcp/stockbot-agent-mcp.js";
import { runOnce } from "./worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentsDir = process.env.STOCKBOT_AGENTS_DIR || path.join(os.homedir(), ".config", "stockbot", "agents");
const agentId = (name) => `agent-${name}`;
const enc = encodeURIComponent;

export async function writeAgentEnv({ profile, baseUrl, token, directory = agentsDir }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = path.join(directory, `${profile}.env`);
  await writeFile(file, `# Stockbot swarm agent credentials for Hermes profile ${profile}. Keep private.\nSTOCKBOT_URL=${baseUrl.replace(/\/$/, "")}\nSTOCKBOT_AGENT_TOKEN=${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

/**
 * Hermes setup for one agent. The agent's MCP server is named `stockbot-agent`
 * (toolset `mcp-stockbot-agent`), distinct from the operator bridge, so even if
 * a cloned profile carried an operator `stockbot` server its tools are never in
 * the worker's toolset. The last command must list only `stockbot-agent`.
 */
export function hermesSetupCommands({ profile, envFile, mcpScript = path.join(root, "scripts/mcp/stockbot-agent-mcp.js") }) {
  return [
    `hermes profile create ${profile} --clone`,
    `hermes --profile ${profile} mcp add stockbot-agent --command ${process.execPath} --env STOCKBOT_AGENT_ENV=${envFile} --args ${mcpScript}`,
    `hermes --profile ${profile} mcp test stockbot-agent`,
    `hermes --profile ${profile} mcp list    # remove any other server here (hermes --profile ${profile} mcp remove <name>), especially an operator "stockbot" bridge`
  ];
}

function chain(detail, taskId) {
  const task = detail.tasks.find((entry) => entry.id === taskId);
  const report = detail.reports.find((entry) => entry.taskId === taskId);
  return {
    agent: detail.agent.name,
    task: task && { id: task.id, status: task.status, createdBy: task.createdBy, errorCode: task.errorCode, errorDetail: task.errorDetail },
    report: report && { id: report.id, provenance: report.provenanceJson },
    decisions: report?.decisions.map(({ id, symbol, action, score, rationale }) => ({ id, symbol, action, score, rationale })) ?? [],
    ordersEnabled: detail.agent.intentsEnabled && detail.globalIntentsEnabled,
    intents: detail.intents.length
  };
}

export async function run(argv, { api, bridge, log = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`) } = {}) {
  const [command, name, ...rest] = argv;
  if (!api) {
    bridge = await loadBridgeConfig();
    api = createApi(bridge);
  }
  const profileOf = async (agent) => (await api.get(`/swarm/agents/${enc(agentId(agent))}`)).agent.hermesProfile;
  switch (command) {
    case "create": {
      const planIndex = rest.indexOf("--plan");
      const planFile = planIndex >= 0 ? rest[planIndex + 1] : path.join(root, "research/agents/first-agent-plan.json");
      const agent = await api.post("/swarm/agents", { name });
      const { token } = await api.post(`/swarm/agents/${enc(agent.id)}/tokens`);
      const envFile = await writeAgentEnv({ profile: agent.hermesProfile, baseUrl: bridge.baseUrl, token });
      const saved = await api.post(`/swarm/agents/${enc(agent.id)}/plans`, { plan: JSON.parse(await readFile(planFile, "utf8")) });
      log({ created: agent.id, sleeve: agent.accountId, plan: { id: saved.plan.id, version: saved.plan.version }, ordersEnabled: false, agentEnvFile: envFile });
      log(`\nSet up the agent's Hermes profile (run once in Terminal):\n  ${hermesSetupCommands({ profile: agent.hermesProfile, envFile }).join("\n  ")}\n`);
      return agent;
    }
    case "token": {
      const profile = await profileOf(name);
      const { token } = await api.post(`/swarm/agents/${enc(agentId(name))}/tokens`);
      const envFile = await writeAgentEnv({ profile, baseUrl: bridge.baseUrl, token });
      log({ rotated: agentId(name), agentEnvFile: envFile });
      return envFile;
    }
    case "plan": {
      const saved = await api.post(`/swarm/agents/${enc(agentId(name))}/plans`, { plan: JSON.parse(await readFile(rest[0], "utf8")) });
      log({ plan: saved.plan.id, version: saved.plan.version, created: saved.created });
      return saved;
    }
    case "task": {
      const task = await api.post(`/swarm/agents/${enc(agentId(name))}/tasks`, {});
      log({ task: task.id, dueAt: new Date(task.dueAt).toISOString() });
      return task;
    }
    case "show": {
      const detail = await api.get(`/swarm/agents/${enc(agentId(name))}`);
      log(detail);
      return detail;
    }
    case "status": {
      const updated = await api.post(`/swarm/agents/${enc(agentId(name))}/status`, { status: rest[0] });
      log({ agent: updated.id, status: updated.status });
      return updated;
    }
    case "orders": {
      if (!["on", "off"].includes(rest[0])) throw new Error("orders <agent|swarm> on|off");
      const enabled = rest[0] === "on";
      const result = name === "swarm"
        ? await api.post("/swarm/intents", { enabled })
        : await api.post(`/swarm/agents/${enc(agentId(name))}/intents`, { enabled });
      log(result);
      return result;
    }
    case "tick": {
      const result = await api.post("/swarm/tick");
      log(result);
      return result;
    }
    case "prove": {
      const profile = await profileOf(name);
      const envFile = path.join(agentsDir, `${profile}.env`);
      const { loadAgentConfig } = await import("../mcp/stockbot-agent-mcp.js");
      const agentApi = createAgentApi(await loadAgentConfig({ STOCKBOT_AGENT_ENV: envFile }));
      const task = await api.post(`/swarm/agents/${enc(agentId(name))}/tasks`, {});
      log(`Queued task ${task.id}; running ${profile} through Hermes…`);
      const outcome = await runOnce({ api: agentApi, profile, taskId: task.id, log });
      const detail = await api.get(`/swarm/agents/${enc(agentId(name))}`);
      const proof = { outcome: outcome.outcome, reason: outcome.reason, runDirectory: outcome.directory, chain: chain(detail, task.id) };
      log(proof);
      if (outcome.outcome !== "completed") process.exitCode = 1;
      return proof;
    }
    default:
      throw new Error("Usage: npm run swarm -- create|prove|show|task|plan|status|orders|token|tick …  (see scripts/swarm/agent.js)");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
