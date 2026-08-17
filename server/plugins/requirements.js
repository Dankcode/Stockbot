/**
 * Capability resolution: declare, never supply.
 *
 * A plugin states what it needs — source ids, secret NAMES, prompt templates, the AI
 * summarizer. This file checks that list against what the operator already configured
 * and produces an actionable report. The plugin never carries an origin URL, an
 * executable path, an argv array, or a credential value, so installing one cannot
 * broaden what Stockbot is able to reach.
 *
 * The point is that requirements fail LOUDLY AT INSTALL rather than cryptically at run
 * time. Without this, a plugin whose Bluesky source is unregistered installs cleanly,
 * pins to a session, and then silently produces no snapshots — which shows up much later
 * as a research-gated strategy that mysteriously never trades.
 */
import { hasPromptTemplate, listPromptTemplates } from "./prompt-templates.js";

const ENGINE_VERSION = "0.1.0";

function compareSemver(left, right) {
  const parse = (value) => String(value).split("-", 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [leftParts, rightParts] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

/**
 * @param environment Object with the operator's resolved configuration:
 *   { sources: Record<id, origin>, secretNames: Set<string>|string[],
 *     aiCliConfigured: boolean, engineVersion?: string }
 */
export function resolvePluginRequirements(plugin, environment = {}) {
  const requires = plugin.requires ?? {};
  const availableSources = new Set(Object.keys(environment.sources ?? {}));
  const availableSecrets = new Set(environment.secretNames ?? []);
  const aiCliConfigured = Boolean(environment.aiCliConfigured);
  const engineVersion = environment.engineVersion ?? ENGINE_VERSION;

  const unmet = [];
  const warnings = [];

  if (requires.minEngineVersion && compareSemver(engineVersion, requires.minEngineVersion) < 0) {
    unmet.push({
      kind: "engine",
      detail: requires.minEngineVersion,
      message: `Plugin needs Stockbot engine >= ${requires.minEngineVersion}; this build reports ${engineVersion}.`,
      remedy: "Update Stockbot, or install an older release of this plugin."
    });
  }

  for (const sourceId of requires.sources ?? []) {
    if (!availableSources.has(sourceId)) {
      unmet.push({
        kind: "source",
        detail: sourceId,
        message: `Research source "${sourceId}" is not registered.`,
        remedy: `Add "${sourceId}" to RESEARCH_WEB_SOURCES_JSON in the protected env, restart Stockbot, then run npm run research:probe. See docs/RESEARCH_SOURCES.md for the origin and its authorization status.`
      });
    }
  }

  for (const secretName of requires.secrets ?? []) {
    if (!availableSecrets.has(secretName)) {
      unmet.push({
        kind: "secret",
        detail: secretName,
        message: `Environment variable ${secretName} is not configured.`,
        remedy: `Set ${secretName} in the protected env file and, if the AI CLI must receive it, add its NAME to AI_CLI_ENV_ALLOWLIST_JSON. Never place the value in a plugin.`
      });
    }
  }

  if (requires.aiCli && !aiCliConfigured) {
    unmet.push({
      kind: "aiCli",
      detail: "AI_CLI_COMMAND",
      message: "This plugin summarizes research, but no AI CLI is configured.",
      remedy: "Set AI_CLI_COMMAND to an absolute path for a reviewed JSON-in/JSON-out summarizer, then restart. Stockbot never selects or downloads that executable, and a plugin cannot name it. See docs/AI_RESEARCH.md."
    });
  }

  for (const templateId of requires.promptTemplates ?? []) {
    if (!hasPromptTemplate(templateId)) {
      unmet.push({
        kind: "promptTemplate",
        detail: templateId,
        message: `Prompt template "${templateId}" is not registered in this build.`,
        remedy: `Registered templates: ${listPromptTemplates().map((template) => template.id).join(", ")}. Templates are server-owned; a plugin cannot ship its own instruction text.`
      });
    }
  }

  // Declared-but-unused entries are not fatal, but they make `requires` misleading and
  // usually mean the plugin was edited without updating its manifest.
  const usedSources = new Set();
  const usedTemplates = new Set();
  for (const plan of plugin.research ?? []) {
    for (const step of plan.steps) {
      if (step.kind === "scrape") usedSources.add(step.sourceId);
      if (step.kind === "summarize") usedTemplates.add(step.template);
    }
  }
  for (const sourceId of requires.sources ?? []) {
    if (!usedSources.has(sourceId)) {
      warnings.push(`requires.sources lists "${sourceId}" but no research step reads it.`);
    }
  }
  for (const templateId of requires.promptTemplates ?? []) {
    if (!usedTemplates.has(templateId)) {
      warnings.push(`requires.promptTemplates lists "${templateId}" but no summarize step uses it.`);
    }
  }
  if (requires.capabilities?.includes("paper")) {
    warnings.push("This plugin declares the paper capability. Stockbot simulates every fill; no live brokerage route exists.");
  }

  return Object.freeze({
    satisfied: unmet.length === 0,
    unmet: Object.freeze(unmet),
    warnings: Object.freeze(warnings),
    resolved: Object.freeze({
      sources: Object.freeze((requires.sources ?? []).filter((id) => availableSources.has(id))),
      secrets: Object.freeze((requires.secrets ?? []).filter((name) => availableSecrets.has(name))),
      promptTemplates: Object.freeze((requires.promptTemplates ?? []).filter((id) => hasPromptTemplate(id))),
      aiCli: requires.aiCli ? aiCliConfigured : null,
      engineVersion
    })
  });
}

export function formatRequirementReport(plugin, resolution) {
  const lines = [`${plugin.name} (${plugin.id}@${plugin.version})`];
  const requires = plugin.requires ?? {};
  lines.push(`  capabilities   ${requires.capabilities.join(", ")}`);
  if (requires.sources?.length) lines.push(`  sources        ${requires.sources.join(", ")}`);
  if (requires.secrets?.length) lines.push(`  secrets        ${requires.secrets.join(", ")} (names only)`);
  if (requires.promptTemplates?.length) lines.push(`  prompts        ${requires.promptTemplates.join(", ")}`);
  if (requires.aiCli) lines.push("  ai cli         required");
  lines.push(`  methods        ${plugin.methods?.length ?? 0}   research ${plugin.research?.length ?? 0}   cli skills ${plugin.cli?.skills?.length ?? 0}`);

  if (resolution.satisfied) {
    lines.push("  status         all requirements satisfied");
  } else {
    lines.push(`  status         ${resolution.unmet.length} unmet requirement(s)`);
    for (const item of resolution.unmet) {
      lines.push(`    ! ${item.message}`);
      lines.push(`      ${item.remedy}`);
    }
  }
  for (const warning of resolution.warnings) lines.push(`    ~ ${warning}`);
  return lines.join("\n");
}

export { ENGINE_VERSION };
