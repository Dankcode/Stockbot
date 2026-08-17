/**
 * Plugin discovery, static validation, and compilation.
 *
 * Load order per plugin: parse JSON -> schema -> static expression walk -> compile
 * methods -> lower research. Everything that can be checked without market data is
 * checked before the plugin is considered installed, because the alternative is a broken
 * rule surfacing at bar 3,000 of somebody else's backtest.
 *
 * Plugins live in `plugins/` as `*.plugin.json`. The algorithm registry's `algorithms/`
 * folder is untouched — the two coexist, and a compiled plugin method presents the same
 * `{ id, name, params, init, signal }` descriptor the .js loader produces.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { safeParsePlugin } from "../../packages/shared/plugin.js";
import { collectExpressionReferences, ExpressionError } from "./expression.js";
import { compileMethod } from "./method-engine.js";
import { compilePluginResearch } from "./compile-research.js";

export class PluginLoadError extends Error {
  constructor(message, { code = "PLUGIN_INVALID", file, issues } = {}) {
    super(file ? `${file}: ${message}` : message);
    this.name = "PluginLoadError";
    this.code = code;
    this.file = file;
    this.issues = issues;
  }
}

export function hashPluginSource(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Walks every expression in a method and rejects references that can never resolve:
 * an indicator series the method does not declare, a state key it never initialises, a
 * param with no default, a derived constant that does not exist. These are exactly the
 * mistakes that a schema check cannot catch and that would otherwise throw mid-run.
 */
export function validateMethodReferences(method) {
  const body = method.method;
  const declaredSeries = new Set(Object.keys(body.indicators ?? {}));
  const declaredState = new Set(Object.keys(body.state ?? {}));
  const declaredConstants = new Set(Object.keys(body.derived ?? {}));
  const declaredParams = new Set(Object.keys(method.params ?? {}));
  const problems = [];

  const check = (node, label) => {
    let found;
    try {
      found = collectExpressionReferences(node, label);
    } catch (cause) {
      if (cause instanceof ExpressionError) {
        problems.push(cause.message);
        return null;
      }
      throw cause;
    }
    for (const name of found.series) {
      if (!declaredSeries.has(name)) problems.push(`${label}: unknown indicator series "${name}"`);
    }
    for (const name of found.state) {
      if (!declaredState.has(name)) problems.push(`${label}: unknown state key "${name}"`);
    }
    for (const name of found.constants) {
      if (!declaredConstants.has(name)) problems.push(`${label}: unknown derived constant "${name}"`);
    }
    for (const name of found.params) {
      if (!declaredParams.has(name)) problems.push(`${label}: param "${name}" has no default value`);
    }
    return found;
  };

  // Init-phase expressions run before any bar exists, so a series or bar reference in
  // them is a guaranteed runtime failure rather than a maybe.
  for (const [name, node] of Object.entries(body.derived ?? {})) {
    const found = check(node, `derived.${name}`);
    if (found?.series.size) problems.push(`derived.${name}: derived constants cannot reference indicator series`);
  }
  for (const [name, node] of Object.entries(body.state ?? {})) {
    const found = check(node, `state.${name}`);
    if (found?.series.size) problems.push(`state.${name}: initial state cannot reference indicator series`);
  }
  for (const [name, spec] of Object.entries(body.indicators ?? {})) {
    const found = check(spec.period, `indicators.${name}.period`);
    if (found?.series.size) problems.push(`indicators.${name}.period: a period cannot reference another series`);
  }
  if (body.warmup !== undefined) check(body.warmup, "warmup");
  if (body.seed !== undefined) check(body.seed, "seed");

  let usesRandom = false;
  let usesResearch = false;
  for (const phase of ["entry", "exit"]) {
    (body[phase] ?? []).forEach((rule, index) => {
      const found = check(rule.when, `${phase}[${index}].when`);
      if (found?.random) usesRandom = true;
      if (found?.research) usesResearch = true;
      for (const [key, node] of Object.entries(rule.set ?? {})) {
        if (!declaredState.has(key)) problems.push(`${phase}[${index}].set: assigns undeclared state key "${key}"`);
        const setFound = check(node, `${phase}[${index}].set.${key}`);
        if (setFound?.random) usesRandom = true;
      }
      if (rule.confidence !== undefined) check(rule.confidence, `${phase}[${index}].confidence`);
    });
  }

  // A method that draws randomness without a seed would be nondeterministic and would
  // silently corrupt the result cache, so it is rejected rather than defaulted.
  if (usesRandom && body.seed === undefined) {
    problems.push('method reads {"var":"random"} but declares no `seed`; a seedless draw would break result caching');
  }
  if (!usesRandom && body.seed !== undefined) {
    problems.push("method declares a `seed` but never reads randomness");
  }

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems), usesRandom, usesResearch });
}

export function loadPluginFromObject(raw, { file } = {}) {
  const parsed = safeParsePlugin(raw);
  if (!parsed.success) {
    throw new PluginLoadError("plugin failed schema validation", {
      file,
      code: "PLUGIN_SCHEMA_INVALID",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
    });
  }
  const plugin = parsed.data;

  const problems = [];
  for (const method of plugin.methods) {
    const result = validateMethodReferences(method);
    for (const problem of result.problems) problems.push(`methods.${method.id}.${problem}`);
  }
  if (problems.length > 0) {
    throw new PluginLoadError("plugin contains unresolvable expressions", {
      file,
      code: "PLUGIN_EXPRESSION_INVALID",
      issues: problems
    });
  }

  const methods = plugin.methods.map((definition) => {
    let algorithm;
    try {
      algorithm = compileMethod(definition, { id: definition.id });
    } catch (cause) {
      throw new PluginLoadError(cause.message, { file, code: cause.code ?? "PLUGIN_METHOD_INVALID" });
    }
    return Object.freeze({
      // Namespaced so two plugins can both ship "buy-and-hold" without colliding.
      id: `${plugin.id}/${definition.id}`,
      localId: definition.id,
      pluginId: plugin.id,
      name: definition.name,
      description: definition.description,
      author: definition.author ?? plugin.author,
      role: definition.role,
      horizon: definition.horizon ?? "none",
      controlFor: definition.controlFor ?? null,
      params: Object.freeze({ ...definition.params }),
      algorithm
    });
  });

  return Object.freeze({
    plugin,
    file: file ?? null,
    methods: Object.freeze(methods),
    research: compilePluginResearch(plugin),
    skills: Object.freeze(plugin.cli?.skills ?? []),
    pairings: Object.freeze(plugin.pairings)
  });
}

export async function loadPluginFile(filePath) {
  const source = await readFile(filePath, "utf8");
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (cause) {
    throw new PluginLoadError(`invalid JSON: ${cause.message}`, { file: path.basename(filePath), code: "PLUGIN_JSON_INVALID" });
  }
  const loaded = loadPluginFromObject(raw, { file: path.basename(filePath) });
  return Object.freeze({ ...loaded, path: filePath, source, sourceHash: hashPluginSource(source) });
}

export async function discoverPluginFiles(pluginsDir) {
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".plugin.json"))
    .map((entry) => path.join(pluginsDir, entry.name))
    .sort();
}

export async function loadPluginRegistry(pluginsDir) {
  const files = await discoverPluginFiles(pluginsDir);
  const plugins = [];
  const errors = [];
  const seen = new Map();

  for (const file of files) {
    try {
      const loaded = await loadPluginFile(file);
      const existing = seen.get(loaded.plugin.id);
      if (existing) {
        errors.push({
          file: path.basename(file),
          code: "PLUGIN_DUPLICATE_ID",
          message: `Plugin id "${loaded.plugin.id}" is already provided by ${path.basename(existing)}.`
        });
        continue;
      }
      seen.set(loaded.plugin.id, file);
      plugins.push(loaded);
    } catch (cause) {
      errors.push({
        file: path.basename(file),
        code: cause.code ?? "PLUGIN_INVALID",
        message: cause.message,
        issues: cause.issues
      });
    }
  }

  // Cross-plugin control references resolve only once every plugin is loaded.
  const allMethodIds = new Set(plugins.flatMap((entry) => entry.methods.map((method) => method.id)));
  for (const entry of plugins) {
    for (const pairing of entry.pairings) {
      for (const control of pairing.controls) {
        const qualified = control.includes("/") ? control : `${entry.plugin.id}/${control}`;
        if (!allMethodIds.has(qualified)) {
          errors.push({
            file: path.basename(entry.path),
            code: "PLUGIN_CONTROL_MISSING",
            message: `${entry.plugin.id}: pairing for "${pairing.strategy}" references control "${control}", which no installed plugin provides.`
          });
        }
      }
    }
  }

  return Object.freeze({ plugins: Object.freeze(plugins), errors: Object.freeze(errors) });
}
