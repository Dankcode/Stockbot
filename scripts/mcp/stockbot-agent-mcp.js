#!/usr/bin/env node
/**
 * Stockbot MCP server for ONE swarm agent, registered in that agent's Hermes profile as
 * `stockbot-agent` (toolset `mcp-stockbot-agent`).
 *
 * It holds that agent's token and nothing else, so every tool acts on the
 * agent's own tasks, receipts, sleeve and decisions. There is no tool to claim
 * work (the worker does that), to read another agent, to touch sessions,
 * strategies, settings or raw orders, or to assert where evidence came from:
 * `retrieve` asks Stockbot to fetch the data itself and returns a receipt id,
 * and reports may cite only those ids.
 *
 * Configuration (the token never goes in Hermes config.yaml or on argv):
 *   STOCKBOT_AGENT_ENV  path to a 0600 file with
 *                       STOCKBOT_URL=http://127.0.0.1:4000  (or https://<host>.<tailnet>.ts.net)
 *                       STOCKBOT_AGENT_TOKEN=sbat_…
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { BridgeError, createServer, parseEnvText, validateBaseUrl } from "./stockbot-mcp.js";

const SERVER_INFO = { name: "stockbot-agent", version: "1.0.0" };
const INSTRUCTIONS = "You are one Stockbot swarm agent. Work only on the task current_task returns. Get every fact through retrieve; cite the receiptIds it returns as evidence. Never state a price, trend or source you did not retrieve. Finish by calling submit_report exactly once, or fail_task if you cannot.";
const SYMBOL = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9.]{0,9}$" };
const ID = { type: "string", minLength: 1, maxLength: 128 };

export async function loadAgentConfig(environment = process.env) {
  const file = environment.STOCKBOT_AGENT_ENV;
  if (!file) throw new BridgeError("STOCKBOT_AGENT_ENV is not set in this Hermes profile's MCP server env.", "CONFIG_MISSING");
  let values;
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw new BridgeError(`${file} is not a regular file.`, "CONFIG_INVALID");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new BridgeError(`${file} must be readable only by you (chmod 600).`, "CONFIG_PERMISSIONS");
    }
    values = parseEnvText(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(`Cannot read ${file}.`, "CONFIG_INVALID");
  }
  const token = String(values.STOCKBOT_AGENT_TOKEN ?? "");
  if (!token.startsWith("sbat_")) throw new BridgeError("STOCKBOT_AGENT_TOKEN is missing or is not an agent token.", "CONFIG_MISSING");
  return { baseUrl: validateBaseUrl(values.STOCKBOT_URL), token };
}

export function createAgentApi({ baseUrl, token }, { fetchImpl = fetch, timeoutMs = 60_000 } = {}) {
  async function request(method, route, body) {
    let response;
    try {
      response = await fetchImpl(new URL(`/api/v1/agent${route}`, baseUrl), {
        method,
        headers: {
          accept: "application/json",
          "x-stockbot-agent-token": token,
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new BridgeError(`Cannot reach Stockbot at ${baseUrl} (${error?.cause?.code ?? error?.name ?? "network error"}).`, "UNREACHABLE");
    }
    let payload;
    try { payload = await response.json(); } catch { throw new BridgeError(`Stockbot returned non-JSON HTTP ${response.status}.`, "INVALID_RESPONSE"); }
    // Rejected intents are a normal, informative answer, not a transport error.
    if (response.status === 422 && payload?.data?.intent) return payload.data;
    if (!response.ok || payload?.error) {
      const detail = payload?.error?.detail ? ` ${JSON.stringify(payload.error.detail).slice(0, 600)}` : "";
      throw new BridgeError(`${payload?.error?.message ?? `HTTP ${response.status}`}${detail}`, payload?.error?.code ?? `HTTP_${response.status}`);
    }
    return payload.data;
  }
  return { get: (route) => request("GET", route), post: (route, body) => request("POST", route, body ?? {}) };
}

const enc = encodeURIComponent;

export const AGENT_TOOLS = [
  {
    name: "current_task",
    description: "Your claimed task: its id, deadline, the plan (universe, sources, decision policy), and receipts already retrieved for it. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(api) {
      const current = await api.get("/tasks/current");
      if (!current) return { task: null, note: "No claimed task. Stop; there is nothing to do." };
      const me = await api.get("/me");
      return { ...current, ordersEnabled: me.intentsEnabled };
    }
  },
  {
    name: "retrieve",
    description: "Ask Stockbot to fetch data for the task and record a receipt. kind: market.quote {symbol} | market.bars {symbol, range: 1D|1W|1M|3M|1Y} | web.page {sourceId, path}. Returns receiptId, provider and the content. Only declared plan sources and universe symbols are allowed.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: ID,
        kind: { type: "string", enum: ["market.quote", "market.bars", "web.page"] },
        symbol: SYMBOL,
        range: { type: "string", enum: ["1D", "1W", "1M", "3M", "1Y"] },
        sourceId: ID,
        path: { type: "string", maxLength: 512 }
      },
      required: ["taskId", "kind"],
      additionalProperties: false
    },
    async run(api, { taskId, ...request }) {
      return api.post(`/tasks/${enc(taskId)}/retrievals`, request);
    }
  },
  {
    name: "portfolio",
    description: "Your own paper sleeve: cash, equity and positions (cents; qty in micro-shares).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async run(api) { return api.get("/portfolio"); }
  },
  {
    name: "submit_report",
    description: "Submit the task's report once. decisions: one per symbol you assessed, action hold|buy|sell, optional score 1-10, a rationale, and evidence = receiptIds from retrieve. Completes the task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: ID,
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        decisions: {
          type: "array", minItems: 1, maxItems: 25,
          items: {
            type: "object",
            properties: {
              symbol: SYMBOL,
              action: { type: "string", enum: ["hold", "buy", "sell"] },
              score: { type: "integer", minimum: 1, maximum: 10 },
              rationale: { type: "string", minLength: 1, maxLength: 2000 },
              evidence: { type: "array", items: ID, minItems: 1, maxItems: 20 }
            },
            required: ["symbol", "action", "rationale", "evidence"],
            additionalProperties: false
          }
        }
      },
      required: ["taskId", "summary", "decisions"],
      additionalProperties: false
    },
    async run(api, { taskId, ...report }) {
      const result = await api.post(`/tasks/${enc(taskId)}/report`, report);
      return {
        reportId: result.report.id,
        taskStatus: result.task.status,
        provenance: result.report.provenanceJson,
        decisions: result.decisions.map(({ id, symbol, action, score }) => ({ decisionId: id, symbol, action, score }))
      };
    }
  },
  {
    name: "submit_intent",
    description: "Ask Stockbot to trade on one of your buy/sell decisions in your own sleeve. Disabled unless the operator enabled orders; a rejection reason is returned either way. idempotencyKey must be unique per intended trade; reuse it to retry.",
    inputSchema: {
      type: "object",
      properties: {
        idempotencyKey: { type: "string", pattern: "^[A-Za-z0-9:._-]{8,128}$" },
        decisionId: ID,
        symbol: SYMBOL,
        side: { type: "string", enum: ["buy", "sell"] },
        notional: { type: "number", exclusiveMinimum: 0, maximum: 1000000 }
      },
      required: ["idempotencyKey", "decisionId", "symbol", "side"],
      additionalProperties: false
    },
    async run(api, args) { return api.post("/intents", args); }
  },
  {
    name: "fail_task",
    description: "Give up on the task with a short reason (for example a retrieval kept failing). Use instead of submitting a report you cannot support.",
    inputSchema: {
      type: "object",
      properties: { taskId: ID, code: { type: "string", maxLength: 64 }, detail: { type: "string", maxLength: 2000 } },
      required: ["taskId"],
      additionalProperties: false
    },
    async run(api, { taskId, ...body }) { return api.post(`/tasks/${enc(taskId)}/fail`, body); }
  }
];

export function createAgentServer({ getApi, write }) {
  return createServer({ getApi, write, tools: AGENT_TOOLS, instructions: INSTRUCTIONS, serverInfo: SERVER_INFO });
}

async function main() {
  let apiPromise;
  const getApi = () => (apiPromise ??= loadAgentConfig().then((config) => createAgentApi(config)).catch((error) => {
    apiPromise = undefined;
    throw error;
  }));
  const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  const handle = createAgentServer({ getApi, write });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    void handle(message);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
