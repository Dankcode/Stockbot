#!/usr/bin/env node
/**
 * Stockbot plugin CLI.
 *
 *   npm run plugin -- list
 *   npm run plugin -- validate --file plugins/horizon-pack.plugin.json
 *   npm run plugin -- inspect --plugin sentiment-pack
 *   npm run plugin -- requirements [--plugin ID] [--env-file PATH]
 *   npm run plugin -- templates
 *   npm run plugin -- export --plugin gov-research --out research-plans/
 *   npm run plugin -- skill list
 *   npm run plugin -- skill run --skill sentiment-pack/daily-sentiment-sweep --symbol NVDA
 *
 * `skill run` is the CLI skill-building surface. A skill names research plans defined in
 * the same plugin; this command resolves them, checks the plugin's requirements against
 * the operator's configuration, and drives the existing loopback research API to gather
 * evidence. It never executes anything a plugin names, because a plugin cannot name an
 * executable — the format has no field for one.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseEnv } from "dotenv";

import { loadPluginFile, loadPluginRegistry } from "../server/plugins/registry.js";
import { resolvePluginRequirements, formatRequirementReport } from "../server/plugins/requirements.js";
import { listPromptTemplates, renderPrompt } from "../server/plugins/prompt-templates.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");

function cliError(message, code = "PLUGIN_CLI_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const [command, subcommand, ...rest] = argv;
  const tokens = subcommand && !subcommand.startsWith("--") ? rest : [subcommand, ...rest].filter(Boolean);
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (!token.startsWith("--")) throw cliError(`Unexpected argument: ${token}`);
    const [rawName, inline] = token.slice(2).split("=", 2);
    if (rawName === "help") { options.help = true; continue; }
    if (rawName === "json") { options.json = true; continue; }
    const value = inline ?? tokens[++index];
    if (value == null || String(value).startsWith("--")) throw cliError(`--${rawName} requires a value.`);
    options[rawName.replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase())] = value;
  }
  return { command, subcommand: subcommand && !subcommand.startsWith("--") ? subcommand : null, options };
}

async function loadEnvironment(envFile) {
  if (!envFile) {
    try {
      return { ...parseEnv(await readFile(path.join(ROOT, ".env"), "utf8")), ...process.env };
    } catch (error) {
      if (error?.code === "ENOENT") return process.env;
      throw cliError("The project .env file cannot be read.", "ERR_ENV_FILE_INVALID");
    }
  }
  const resolved = path.resolve(envFile);
  let metadata;
  try { metadata = await stat(resolved); }
  catch { throw cliError("The requested environment file cannot be read.", "ERR_ENV_FILE_NOT_FOUND"); }
  if (!metadata.isFile()) throw cliError("--env-file must identify a regular file.", "ERR_ENV_FILE_INVALID");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw cliError("The environment file must have owner-only permissions (chmod 600).", "ERR_ENV_FILE_PERMISSIONS");
  }
  return { ...parseEnv(await readFile(resolved, "utf8")), ...process.env };
}

/**
 * Builds the capability picture from the operator's configuration. Note what is read and
 * what is not: source IDS (not their URLs beyond presence), secret NAMES (never values),
 * and whether an AI CLI path is set (never the path itself). That asymmetry is the whole
 * security model — a plugin learns that a capability exists, never what backs it.
 */
function describeEnvironment(environment) {
  let sources = {};
  try {
    sources = JSON.parse(environment.RESEARCH_WEB_SOURCES_JSON ?? "{}");
  } catch {
    sources = {};
  }
  const secretNames = Object.keys(environment).filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key) && String(environment[key] ?? "").trim() !== "");
  return {
    sources,
    secretNames,
    aiCliConfigured: String(environment.AI_CLI_COMMAND ?? "").trim() !== ""
  };
}

async function apiRequest(baseUrl, token, requestPath, options = {}) {
  const response = await fetch(new URL(requestPath, baseUrl), {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      "x-stockbot-token": token,
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 180_000)
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw cliError(`Stockbot API returned non-JSON HTTP ${response.status}.`, "PLUGIN_API_INVALID_RESPONSE"); }
  if (!response.ok || payload?.error) {
    throw cliError(payload?.error?.message ?? `Stockbot API returned HTTP ${response.status}.`, payload?.error?.code ?? "PLUGIN_API_ERROR");
  }
  return payload.data;
}

function usage() {
  return `Stockbot plugin CLI

  npm run plugin -- list
  npm run plugin -- validate --file PLUGIN.json
  npm run plugin -- inspect --plugin ID
  npm run plugin -- requirements [--plugin ID] [--env-file PATH]
  npm run plugin -- templates [--template ID]
  npm run plugin -- export --plugin ID [--out DIR]
  npm run plugin -- skill list
  npm run plugin -- skill run --skill PLUGIN/SKILL --symbol SYM [--env-file PATH]

Plugins are data. They declare the sources, secret names, prompt templates, and CLI
facilities they need; they never carry a URL binding, a credential, or a command.
`;
}

async function main() {
  const { command, subcommand, options } = parseArguments(process.argv.slice(2));
  if (!command || options.help) { process.stdout.write(usage()); return 0; }

  if (command === "templates") {
    const templates = listPromptTemplates();
    if (options.template) {
      const chosen = templates.find((template) => template.id === options.template);
      if (!chosen) throw cliError(`Unknown template "${options.template}".`);
      const rendered = renderPrompt(chosen.id, {});
      process.stdout.write(`${chosen.id} (v${chosen.version})\n  slots: ${chosen.slots.join(", ") || "none"}\n  ${chosen.description}\n\n  rendered with no slots:\n  ${rendered.prompt.instructions}\n`);
      return 0;
    }
    for (const template of templates) {
      process.stdout.write(`${template.id.padEnd(30)} slots: ${template.slots.join(", ") || "none"}\n  ${template.description}\n`);
    }
    return 0;
  }

  if (command === "validate") {
    const file = options.file;
    if (!file) throw cliError("--file is required.");
    try {
      const loaded = await loadPluginFile(path.resolve(file));
      process.stdout.write(`OK ${loaded.plugin.id}@${loaded.plugin.version} — ${loaded.methods.length} methods, ${loaded.research.length} research plans, ${loaded.skills.length} CLI skills\n`);
      process.stdout.write(`   sha256 ${loaded.sourceHash}\n`);
      return 0;
    } catch (cause) {
      process.stderr.write(`FAIL ${cause.message}\n`);
      for (const issue of cause.issues ?? []) process.stderr.write(`     ${issue}\n`);
      return 1;
    }
  }

  const registry = await loadPluginRegistry(PLUGINS_DIR);
  for (const error of registry.errors) {
    process.stderr.write(`! ${error.file}: ${error.message}\n`);
    for (const issue of error.issues ?? []) process.stderr.write(`    ${issue}\n`);
  }
  const find = (id) => {
    const entry = registry.plugins.find((candidate) => candidate.plugin.id === id);
    if (!entry) throw cliError(`Plugin "${id}" is not installed. Installed: ${registry.plugins.map((p) => p.plugin.id).join(", ") || "none"}.`);
    return entry;
  };

  if (command === "list") {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(registry.plugins.map((e) => ({ id: e.plugin.id, version: e.plugin.version, name: e.plugin.name, methods: e.methods.length, research: e.research.length, skills: e.skills.length })), null, 2)}\n`);
      return 0;
    }
    for (const entry of registry.plugins) {
      process.stdout.write(`${`${entry.plugin.id}@${entry.plugin.version}`.padEnd(28)} ${entry.methods.length} methods · ${entry.research.length} research · ${entry.skills.length} skills\n`);
      process.stdout.write(`  ${entry.plugin.name}\n`);
    }
    return registry.errors.length > 0 ? 1 : 0;
  }

  if (command === "inspect") {
    const entry = find(options.plugin ?? "");
    if (options.json) { process.stdout.write(`${JSON.stringify(entry.plugin, null, 2)}\n`); return 0; }
    const { plugin } = entry;
    process.stdout.write(`${plugin.name}\n${plugin.id}@${plugin.version}${plugin.license ? ` · ${plugin.license}` : ""}${plugin.author ? ` · ${plugin.author}` : ""}\n`);
    if (plugin.description) process.stdout.write(`\n${plugin.description}\n`);
    process.stdout.write(`\nRequires\n  capabilities   ${plugin.requires.capabilities.join(", ")}\n`);
    if (plugin.requires.sources.length) process.stdout.write(`  sources        ${plugin.requires.sources.join(", ")}\n`);
    if (plugin.requires.secrets.length) process.stdout.write(`  secrets        ${plugin.requires.secrets.join(", ")} (names only)\n`);
    if (plugin.requires.promptTemplates.length) process.stdout.write(`  prompts        ${plugin.requires.promptTemplates.join(", ")}\n`);
    if (plugin.requires.aiCli) process.stdout.write("  ai cli         required\n");
    if (plugin.requires.notes) process.stdout.write(`  notes          ${plugin.requires.notes}\n`);

    if (entry.methods.length) {
      process.stdout.write("\nMethods\n");
      for (const method of entry.methods) {
        process.stdout.write(`  ${method.localId.padEnd(22)} ${method.role.padEnd(10)} ${method.horizon.padEnd(8)} ${method.name}\n`);
      }
    }
    if (entry.pairings.length) {
      process.stdout.write("\nPairings (every strategy ships its controls)\n");
      for (const pairing of entry.pairings) {
        process.stdout.write(`  ${pairing.strategy}\n    vs ${pairing.controls.join(", ")}  (${pairing.seeds} seeds)\n`);
        for (const [control, params] of Object.entries(pairing.controlParams ?? {})) {
          process.stdout.write(`       ${control} ${JSON.stringify(params)}\n`);
        }
      }
    }
    if (entry.research.length) {
      process.stdout.write("\nResearch\n");
      for (const compiled of entry.research) {
        const scrapes = compiled.plan.steps.filter((step) => step.kind === "scrape");
        process.stdout.write(`  ${compiled.plan.id}\n    ${scrapes.length} scrape step(s), templates: ${compiled.templates.map((t) => `${t.template}${Object.keys(t.slots).length ? ` ${JSON.stringify(t.slots)}` : ""}`).join(", ")}\n`);
      }
    }
    if (entry.skills.length) {
      process.stdout.write("\nCLI skills\n");
      for (const skill of entry.skills) {
        process.stdout.write(`  ${skill.id.padEnd(24)} gathers ${skill.gather.join(", ")}  (${skill.suggestedCadence}, min ${skill.minSnapshots})\n`);
        if (skill.description) process.stdout.write(`    ${skill.description}\n`);
      }
    }
    return 0;
  }

  if (command === "requirements") {
    const environment = await loadEnvironment(options.envFile);
    const described = describeEnvironment(environment);
    const targets = options.plugin ? [find(options.plugin)] : registry.plugins;
    let unmet = 0;
    for (const entry of targets) {
      const resolution = resolvePluginRequirements(entry.plugin, described);
      if (!resolution.satisfied) unmet += 1;
      process.stdout.write(`${formatRequirementReport(entry.plugin, resolution)}\n\n`);
    }
    return unmet > 0 ? 1 : 0;
  }

  if (command === "export") {
    const entry = find(options.plugin ?? "");
    const outDir = path.resolve(options.out ?? path.join(ROOT, "research-plans"));
    await mkdir(outDir, { recursive: true });
    for (const compiled of entry.research) {
      const file = path.join(outDir, `${compiled.plan.id}.json`);
      await writeFile(file, `${JSON.stringify(compiled.plan, null, 2)}\n`);
      process.stdout.write(`wrote ${path.relative(ROOT, file)}\n`);
    }
    if (entry.research.length === 0) process.stdout.write(`${entry.plugin.id} defines no research plans.\n`);
    return 0;
  }

  if (command === "skill") {
    const allSkills = registry.plugins.flatMap((entry) =>
      entry.skills.map((skill) => ({ entry, skill, ref: `${entry.plugin.id}/${skill.id}` }))
    );

    if (!subcommand || subcommand === "list") {
      for (const { entry, skill, ref } of allSkills) {
        process.stdout.write(`${ref.padEnd(42)} ${skill.suggestedCadence}\n  ${skill.name} — gathers ${skill.gather.map((id) => `${entry.plugin.id}.${id}`).join(", ")}\n`);
        if (skill.description) process.stdout.write(`  ${skill.description}\n`);
      }
      if (allSkills.length === 0) process.stdout.write("No installed plugin defines a CLI skill.\n");
      return 0;
    }

    if (subcommand !== "run") throw cliError(`Unknown skill subcommand "${subcommand}".`);
    const ref = options.skill;
    if (!ref) throw cliError("--skill PLUGIN/SKILL is required.");
    const found = allSkills.find((candidate) => candidate.ref === ref);
    if (!found) throw cliError(`Unknown skill "${ref}". Try: npm run plugin -- skill list`);

    const environment = await loadEnvironment(options.envFile);
    const described = describeEnvironment(environment);
    const resolution = resolvePluginRequirements(found.entry.plugin, described);
    if (!resolution.satisfied) {
      process.stderr.write(`Cannot run ${ref}: ${resolution.unmet.length} unmet requirement(s).\n\n`);
      process.stderr.write(`${formatRequirementReport(found.entry.plugin, resolution)}\n`);
      return 1;
    }

    const token = String(environment.STOCKBOT_API_TOKEN ?? "");
    if (token.length < 32) throw cliError("STOCKBOT_API_TOKEN must be configured.", "AUTH_NOT_CONFIGURED");
    const port = Number(environment.PORT || 4000);
    const baseUrl = `http://127.0.0.1:${port}/`;

    const symbols = options.symbol
      ? [String(options.symbol).trim().toUpperCase()]
      : found.skill.defaultSymbols;
    if (symbols.length === 0) {
      throw cliError(`Skill "${ref}" has no defaultSymbols; pass --symbol.`);
    }

    let produced = 0;
    let attempted = 0;
    for (const symbol of symbols) {
      for (const planLocalId of found.skill.gather) {
        const planId = `${found.entry.plugin.id}.${planLocalId}`;
        attempted += 1;
        process.stdout.write(`→ ${symbol} ${planId} … `);
        try {
          const data = await apiRequest(baseUrl, token, "/api/v1/research/runs", {
            method: "POST",
            body: { planId, symbol }
          });
          const snapshotId = data?.snapshotId ?? data?.snapshot?.id ?? null;
          if (snapshotId) { produced += 1; process.stdout.write(`snapshot ${snapshotId}\n`); }
          else process.stdout.write("completed with no snapshot\n");
        } catch (cause) {
          process.stdout.write(`failed (${cause.code}): ${cause.message}\n`);
        }
      }
    }

    process.stdout.write(`\n${produced}/${attempted} gather step(s) produced a snapshot.\n`);
    if (produced < found.skill.minSnapshots) {
      process.stderr.write(
        `Skill "${ref}" requires at least ${found.skill.minSnapshots} snapshot(s). Run npm run research:probe to see which source failed.\n`
      );
      return 1;
    }
    if (found.skill.suggestedCadence !== "manual") {
      process.stdout.write(
        `\nThis skill suggests a ${found.skill.suggestedCadence} cadence. Schedule THIS command from launchd or cron —\nStockbot never schedules from plugin data, and the format has no field for a scheduler command.\n`
      );
    }
    return 0;
  }

  throw cliError(`Unknown command "${command}".`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}\n`);
    process.exit(1);
  }
);
