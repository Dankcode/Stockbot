/**
 * Presents compiled plugin methods as algorithm-registry descriptors.
 *
 * The point of this file is that nothing downstream needs to know plugins exist. A
 * compiled JSON method produces the same descriptor shape `loadAlgorithmRegistry`
 * produces for a .js file — id, name, params, algorithm, versionHash — so the engine
 * pool, backtest route, session runner, result cache, and dashboard all treat the two
 * identically.
 *
 * Wiring it in is a three-line change at the end of `loadAlgorithmRegistry` in
 * server/algorithms/registry.js:
 *
 *     import { pluginAlgorithmDescriptors } from "../plugins/algorithm-bridge.js";
 *     ...
 *     const bridged = await pluginAlgorithmDescriptors(options.pluginsDir);
 *     algorithms.push(...bridged.algorithms);
 *     errors.push(...bridged.errors);
 *
 * That patch is deliberately left for the operator to apply rather than made here, since
 * it changes a core load path and this module is independently testable without it.
 *
 * Versioning note: a plugin method's `versionHash` is the SHA-256 of the whole plugin
 * file, not of the individual method. Editing any method in a bundle therefore versions
 * every method in it. That is the conservative choice — an over-invalidated cache costs
 * a recomputation, while an under-invalidated one silently serves results from code that
 * no longer exists.
 */
import { createHash } from "node:crypto";
import { loadPluginRegistry } from "./registry.js";

function methodVersionHash(pluginSourceHash, methodId) {
  return createHash("sha256").update(`${pluginSourceHash}:${methodId}`, "utf8").digest("hex");
}

export function descriptorsFromLoadedPlugin(entry) {
  return entry.methods.map((method) =>
    Object.freeze({
      // Namespaced with a slash, matching how uploaded algorithms already use
      // "uploads/<name>", so ids stay unambiguous across all three sources.
      id: method.id,
      file: entry.path ?? `${entry.plugin.id}.plugin.json`,
      path: entry.path ?? null,
      uploaded: false,
      trusted: true,
      // Plugins carry no JavaScript, so there is no source text to hand a worker. The
      // interpreter is the sandbox, and it runs in-process safely.
      source: null,
      sourceHash: entry.sourceHash ?? null,
      versionHash: methodVersionHash(entry.sourceHash ?? entry.plugin.version, method.localId),
      name: method.name,
      author: method.author,
      description: method.description,
      params: method.params,
      signal: method.algorithm.signal,
      init: method.algorithm.init,
      algorithm: method.algorithm,
      plugin: Object.freeze({
        id: entry.plugin.id,
        version: entry.plugin.version,
        methodId: method.localId,
        role: method.role,
        horizon: method.horizon,
        controlFor: method.controlFor
      })
    })
  );
}

export async function pluginAlgorithmDescriptors(pluginsDir) {
  if (!pluginsDir) return Object.freeze({ algorithms: Object.freeze([]), errors: Object.freeze([]) });
  const registry = await loadPluginRegistry(pluginsDir);
  const algorithms = registry.plugins.flatMap((entry) => descriptorsFromLoadedPlugin(entry));
  const errors = registry.errors.map((error) =>
    Object.freeze({
      id: error.file,
      file: error.file,
      code: error.code,
      error: [error.message, ...(error.issues ?? [])].join(" | ")
    })
  );
  return Object.freeze({ algorithms: Object.freeze(algorithms), errors: Object.freeze(errors) });
}

/**
 * Resolves a pairing into concrete run specs: the strategy plus every control with its
 * congruent params already applied, and the random control expanded across seeds. This
 * is what turns "every strategy ships its controls" from a documentation promise into
 * something a runner can execute without the operator hand-copying parameters.
 */
export function expandPairing(registryEntries, pluginId, pairing) {
  const all = new Map(
    registryEntries.flatMap((entry) => entry.methods.map((method) => [method.id, method]))
  );
  const qualify = (ref) => (ref.includes("/") ? ref : `${pluginId}/${ref}`);
  const strategyId = qualify(pairing.strategy);
  const strategy = all.get(strategyId);
  if (!strategy) return null;

  const runs = [{ kind: "strategy", id: strategyId, params: {} }];
  for (const control of pairing.controls) {
    const controlId = qualify(control);
    const method = all.get(controlId);
    if (!method) continue;
    const params = { ...(pairing.controlParams?.[control] ?? pairing.controlParams?.[controlId] ?? {}) };
    // A control that reads randomness is only meaningful as a distribution, so it is
    // expanded across the pairing's seed count rather than run once.
    if ("seed" in method.params) {
      for (let seed = 1; seed <= (pairing.seeds ?? 10); seed += 1) {
        runs.push({ kind: "control", id: controlId, params: { ...params, seed } });
      }
    } else {
      runs.push({ kind: "control", id: controlId, params });
    }
  }
  return Object.freeze({ strategy: strategyId, runs: Object.freeze(runs) });
}
