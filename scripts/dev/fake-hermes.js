#!/usr/bin/env node
// A stand-in for the Hermes CLI that is strict where the real one is: it
// accepts only the flags verified in hermes_cli/_parser.py, answers
// `chat --help`, and fails like argparse (exit 2) on anything else. Behaviour
// after parsing is chosen by FAKE_HERMES_MODE.
import { readFileSync, writeFileSync } from "node:fs";

const VALUE_FLAGS = new Set(["--query-file", "--toolsets", "--max-turns", "--run-budget", "--source"]);
const BOOLEAN_FLAGS = new Set(["--quiet", "--ignore-rules"]);
const argv = process.argv.slice(2);
const parsed = { profile: null };
let index = 0;
if (argv[0] === "--profile") { parsed.profile = argv[1]; index = 2; }
if (argv[index] !== "chat") { console.error(`hermes: error: unknown command ${argv[index]}`); process.exit(2); }
index += 1;
if (argv[index] === "--help") {
  // Shape of argparse's real `hermes chat --help` options section.
  const help = `usage: hermes chat [-h] [-q QUERY | --query-file PATH] [-t TOOLSETS] [-Q]

options:
  --query-file PATH     Read the single query from a file
  -t, --toolsets TOOLSETS
  -Q, --quiet           Quiet mode for programmatic use
  --max-turns N         Maximum tool-calling iterations per conversation turn
  --run-budget SECONDS  Optional wall-clock budget in seconds
  --ignore-rules        Skip auto-injection of AGENTS.md, SOUL.md, memory
  --source SOURCE       Session source tag for filtering
`;
  console.log(process.env.FAKE_HERMES_DROP_FLAG ? help.split(process.env.FAKE_HERMES_DROP_FLAG).join("") : help);
  process.exit(0);
}
for (; index < argv.length; index += 1) {
  const flag = argv[index];
  if (VALUE_FLAGS.has(flag)) { parsed[flag] = argv[++index]; continue; }
  if (BOOLEAN_FLAGS.has(flag)) { parsed[flag] = true; continue; }
  console.error(`hermes chat: error: unrecognized arguments: ${flag}`);
  process.exit(2);
}
if (!parsed["--query-file"]) { console.error("hermes chat: --query-file required here"); process.exit(2); }
if (process.env.FAKE_HERMES_RECORD) writeFileSync(process.env.FAKE_HERMES_RECORD, JSON.stringify({ argv, parsed, cwd: process.cwd(), envKeys: Object.keys(process.env).sort() }));
const prompt = readFileSync(parsed["--query-file"], "utf8");
const mode = process.env.FAKE_HERMES_MODE ?? "report";
if (mode === "report") { console.log(`# Test research report\n\n(prompt ${prompt.length} chars)`); process.exit(0); }
// A fake key in the shape providers use, assembled so no key-shaped literal is committed.
if (mode === "fail") { console.error(`Traceback: provider error token=${["sk", "live", "fakefakefakefakefake"].join("-")}`); process.exit(1); }
if (mode === "agent") {
  const { runFakeAgent } = await import(process.env.FAKE_HERMES_AGENT);
  await runFakeAgent({ prompt, parsed });
  process.exit(0);
}
process.exit(3);
