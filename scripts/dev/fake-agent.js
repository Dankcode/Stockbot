// Deterministic stand-in for the LLM inside Hermes: it talks to the REAL
// Stockbot agent MCP server over stdio, exactly as Hermes would after loading
// the profile's mcp_servers.stockbot entry, and records a HOLD per symbol.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

export async function runFakeAgent() {
  const server = spawn(process.execPath, [path.resolve(process.env.FAKE_AGENT_MCP)], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, STOCKBOT_AGENT_ENV: process.env.FAKE_AGENT_ENV },
    stdio: ["pipe", "pipe", "inherit"]
  });
  let buffer = "";
  const waiting = new Map();
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      waiting.get(message.id)?.(message);
    }
  });
  let next = 1;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const reply = await rpc("tools/call", { name, arguments: args });
    const text = reply.result.content[0].text;
    if (reply.result.isError) throw new Error(`${name}: ${text}`);
    return JSON.parse(text);
  };

  const transcript = [];
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-hermes", version: "0" } });
  const tools = (await rpc("tools/list", {})).result.tools.map((tool) => tool.name);
  transcript.push({ tools });
  const current = await call("current_task");
  const taskId = current.task.id;
  const decisions = [];
  for (const symbol of current.plan.universe.symbols) {
    const quote = await call("retrieve", { taskId, kind: "market.quote", symbol });
    const bars = await call("retrieve", { taskId, kind: "market.bars", symbol, range: "3M" });
    decisions.push({
      symbol,
      action: "hold",
      score: 5,
      rationale: `Last ${quote.content.price} from ${quote.provider}; ${bars.content.count} daily bars show no setup that clears the plan's bar.`,
      evidence: [quote.receiptId, bars.receiptId]
    });
  }
  const report = await call("submit_report", { taskId, summary: "No entries; holding every name.", decisions });
  transcript.push({ ordersEnabled: current.ordersEnabled, report });
  if (process.env.FAKE_AGENT_TRANSCRIPT) writeFileSync(process.env.FAKE_AGENT_TRANSCRIPT, JSON.stringify(transcript));
  server.stdin.end();
  console.log(`Report ${report.reportId} submitted with ${decisions.length} HOLD decisions.`);
}
