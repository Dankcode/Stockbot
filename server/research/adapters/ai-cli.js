import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { MarketResearchSummarySchema } from "../../../packages/shared/research.js";
import { MARKET_SUMMARY_PROMPT, MARKET_SUMMARY_PROMPT_HASH } from "../prompts.js";

const CliResponseSchema = z.object({
  summary: MarketResearchSummarySchema,
  model: z.string().trim().min(1).max(200).optional()
}).strict();

function cliError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedDocuments(documents, maxInputBytes) {
  const output = [];
  let remaining = maxInputBytes;
  for (const document of documents) {
    if (remaining <= 0) break;
    const metadata = {
      stepId: document.stepId,
      sourceId: document.sourceId,
      url: document.finalUrl,
      title: document.title,
      fetchedAt: document.fetchedAt,
      publishedAt: document.publishedAt,
      contentHash: document.contentHash
    };
    const overhead = Buffer.byteLength(JSON.stringify(metadata), "utf8");
    if (overhead >= remaining) break;
    let text = document.text;
    while (Buffer.byteLength(text, "utf8") > remaining - overhead) text = text.slice(0, Math.max(0, Math.floor(text.length * 0.9)));
    output.push({ ...metadata, text });
    remaining -= overhead + Buffer.byteLength(text, "utf8");
  }
  return output;
}

function childEnvironment(environment, allowlist = []) {
  const names = new Set(["PATH", "TMPDIR", "LANG", "LC_ALL", ...allowlist]);
  return Object.fromEntries([...names].filter((name) => typeof environment[name] === "string").map((name) => [name, environment[name]]));
}

export function createAiCliAdapter({
  command = "",
  args = [],
  model = "operator-configured-cli",
  timeoutMs = 60_000,
  maxOutputBytes = 100_000,
  maxInputBytes = 500_000,
  envAllowlist = [],
  environment = process.env,
  spawnProcess = spawn
} = {}) {
  const configuredCommand = String(command).trim();
  if (configuredCommand && !isAbsolute(configuredCommand)) {
    throw new TypeError("AI CLI command must be an absolute executable path.");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("AI CLI args must be an array of strings.");
  }
  if (!Array.isArray(envAllowlist) || envAllowlist.some((value) => !/^[A-Z_][A-Z0-9_]*$/.test(value))) {
    throw new TypeError("AI CLI environment allowlist contains an invalid variable name.");
  }
  const configuredArgs = Object.freeze(args.slice());
  const configuredEnvAllowlist = Object.freeze(envAllowlist.slice());
  const summarizerConfigHash = sha256(JSON.stringify({
    adapter: "ai.cli.summary.v1",
    version: "1",
    command: configuredCommand,
    args: configuredArgs,
    model,
    timeoutMs,
    maxInputBytes,
    maxOutputBytes,
    envAllowlist: [...configuredEnvAllowlist].sort()
  }));

  return Object.freeze({
    id: "ai.cli.summary.v1",
    kind: "summarize",
    version: "1",
    available: Boolean(configuredCommand),
    async execute({ step, symbol, inputs, signal }) {
      if (!configuredCommand) {
        throw cliError("AI CLI summarizer is not configured by the server operator.", "AI_CLI_UNCONFIGURED");
      }
      const documents = inputs.flatMap((input) => input?.documents ?? []);
      if (documents.length === 0) throw cliError("AI summary requires at least one scraped document.", "AI_CLI_INPUT_EMPTY");
      const inputLimit = Math.min(maxInputBytes, step.limits?.maxInputBytes ?? maxInputBytes);
      const envelope = {
        protocolVersion: 1,
        task: "market-research-summary",
        symbol,
        prompt: MARKET_SUMMARY_PROMPT,
        documents: []
      };
      const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
      const payload = {
        ...envelope,
        documents: boundedDocuments(documents, Math.max(0, inputLimit - envelopeBytes - 1_024))
      };
      if (payload.documents.length === 0) throw cliError("AI summary input exceeded its byte budget.", "AI_CLI_INPUT_TOO_LARGE");
      const encodedPayload = JSON.stringify(payload);
      if (Buffer.byteLength(encodedPayload, "utf8") > inputLimit) {
        throw cliError("AI summary input exceeded its byte budget.", "AI_CLI_INPUT_TOO_LARGE");
      }
      const inputDocuments = payload.documents.map((document) => {
        const source = documents.find((candidate) =>
          candidate.stepId === document.stepId &&
          candidate.sourceId === document.sourceId &&
          candidate.contentHash === document.contentHash
        );
        const sourceBytes = Buffer.byteLength(String(source?.text ?? ""), "utf8");
        const includedBytes = Buffer.byteLength(document.text, "utf8");
        return Object.freeze({
          stepId: document.stepId,
          sourceId: document.sourceId,
          contentHash: document.contentHash,
          sourceBytes,
          includedBytes,
          truncated: includedBytes < sourceBytes
        });
      });

      const raw = await new Promise((resolve, reject) => {
        const child = spawnProcess(configuredCommand, configuredArgs, {
          cwd: tmpdir(),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnvironment(environment, configuredEnvAllowlist)
        });
        let stdout = Buffer.alloc(0);
        let stderrBytes = 0;
        let settled = false;
        let forceKillTimer = null;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          callback(value);
        };
        const fail = (error) => finish(reject, error);
        const terminate = () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill("SIGTERM");
          if (forceKillTimer) return;
          forceKillTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          }, 1_000);
          forceKillTimer.unref?.();
        };
        const abort = () => {
          terminate();
          fail(cliError("AI CLI summarizer was canceled.", "AI_CLI_ABORTED"));
        };
        const timer = setTimeout(() => {
          terminate();
          fail(cliError("AI CLI summarizer timed out.", "AI_CLI_TIMEOUT", { timeoutMs }));
        }, Math.min(timeoutMs, step.limits?.timeoutMs ?? timeoutMs));
        child.once("error", (cause) => fail(cliError("AI CLI summarizer could not start.", "AI_CLI_START_FAILED", { cause })));
        child.stdout.on("data", (chunk) => {
          if (stdout.length + chunk.length > maxOutputBytes) {
            terminate();
            fail(cliError("AI CLI output exceeded its byte budget.", "AI_CLI_OUTPUT_TOO_LARGE"));
            return;
          }
          stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
        child.once("close", (code, closeSignal) => {
          if (forceKillTimer) clearTimeout(forceKillTimer);
          if (code !== 0) {
            fail(cliError("AI CLI summarizer exited unsuccessfully.", "AI_CLI_EXIT_FAILED", {
              code,
              signal: closeSignal,
              stderrBytes
            }));
            return;
          }
          finish(resolve, stdout.toString("utf8"));
        });
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        child.stdin.on("error", fail);
        child.stdin.end(encodedPayload);
      });

      let parsed;
      try {
        parsed = CliResponseSchema.parse(JSON.parse(raw));
      } catch (cause) {
        throw cliError("AI CLI returned invalid market-summary.v1 JSON.", "AI_CLI_OUTPUT_INVALID", { cause });
      }
      return Object.freeze({
        kind: "summary",
        summary: parsed.summary,
        model: parsed.model ?? model,
        promptHash: MARKET_SUMMARY_PROMPT_HASH,
        aiInputHash: sha256(encodedPayload),
        summarizerConfigHash,
        inputDocuments: Object.freeze(inputDocuments)
      });
    }
  });
}
