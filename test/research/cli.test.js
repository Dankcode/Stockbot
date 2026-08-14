import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runResearchCli } from "../../scripts/research.js";

const FILE_TOKEN = "file-token-that-is-at-least-32-characters";
const PROCESS_TOKEN = "process-token-that-is-at-least-32-chars";

async function fixture(t, mode = 0o600) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-research-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "stockbot.env");
  const planFile = join(directory, "plan.json");
  await writeFile(envFile, `STOCKBOT_API_TOKEN=${FILE_TOKEN}\nPORT=4400\n`, { mode: 0o600 });
  await chmod(envFile, mode);
  await writeFile(planFile, JSON.stringify({ schemaVersion: 1 }));
  return { envFile, planFile };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("research CLI sends plan source and operator credential only to loopback", async (t) => {
  const { envFile, planFile } = await fixture(t);
  let request;
  let output = "";
  const exitCode = await runResearchCli([
    "validate", "--file", planFile, "--env-file", envFile
  ], {
    env: {},
    stdout: { write(value) { output += value; } },
    async fetch(url, options) {
      request = { url, options };
      return response({ data: { valid: true }, meta: {} });
    }
  });

  assert.equal(exitCode, 0);
  assert.equal(request.url.hostname, "127.0.0.1");
  assert.equal(request.url.port, "4400");
  assert.equal(request.url.pathname, "/api/v1/research/plans/validate");
  assert.equal(request.options.headers["x-stockbot-token"], FILE_TOKEN);
  assert.deepEqual(JSON.parse(request.options.body), {
    filename: "plan.json",
    source: JSON.stringify({ schemaVersion: 1 })
  });
  assert.deepEqual(JSON.parse(output), { valid: true });
});

test("research CLI explicit process environment wins over the protected env file", async (t) => {
  const { envFile } = await fixture(t);
  let observed;
  await runResearchCli(["snapshot", "--id", "snapshot-1", "--env-file", envFile], {
    env: { STOCKBOT_API_TOKEN: PROCESS_TOKEN, PORT: "4500" },
    stdout: { write() {} },
    async fetch(url, options) {
      observed = { url, options };
      return response({ data: [] });
    }
  });
  assert.equal(observed.url.port, "4500");
  assert.equal(observed.url.pathname, "/api/v1/research/snapshots/snapshot-1");
  assert.equal(observed.options.headers["x-stockbot-token"], PROCESS_TOKEN);
});

test("research CLI rejects an insecure env file and preserves API error codes", async (t) => {
  const { envFile } = await fixture(t, 0o644);
  await assert.rejects(
    runResearchCli(["adapters", "--env-file", envFile], { env: {}, stdout: { write() {} } }),
    (error) => error.code === "ERR_ENV_FILE_PERMISSIONS"
  );

  await chmod(envFile, 0o600);
  await assert.rejects(
    runResearchCli(["adapters", "--env-file", envFile], {
      env: {},
      stdout: { write() {} },
      async fetch() {
        return response({ error: { code: "AI_CLI_UNCONFIGURED", message: "AI CLI is unavailable." } }, 503);
      }
    }),
    (error) => error.code === "AI_CLI_UNCONFIGURED" && /unavailable/.test(error.message)
  );
});
