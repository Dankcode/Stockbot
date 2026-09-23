/**
 * Presents compiled plugin methods as algorithm-registry descriptors.
 *
 * The point of this file is that nothing downstream needs to know plugins exist. A
 * compiled JSON method produces the same descriptor shape `loadAlgorithmRegistry`
 * produces for a .js file — id, name, params, algorithm, versionHash — so the engine
 * pool, backtest route, session runner, result cache, and dashboard all treat the two
 * identically.
 *
 * Versioning note: a plugin method's `versionHash` is the SHA-256 of the whole plugin
 * file, not of the individual method. Editing any method in a bundle therefore versions
 * every method in it. That is the conservative choice — an over-invalidated cache costs
 * a recomputation, while an under-invalidated one silently serves results from code that
 * no longer exists.
 */
import { createHash } from "node:crypto";
import { loadPluginRegistry } from "./registry.js";
import { encodePluginMethodSource } from "./algorithm-source.js";

function methodVersionHash(pluginSourceHash, methodId) {
  return createHash("sha256").update(`${pluginSourceHash}:${methodId}`, "utf8").digest("hex");
}

export function descriptorsFromLoadedPlugin(entry) {
  return entry.methods.map((method) => {
    const source = encodePluginMethodSource({
      id: method.id,
      method: method.definition,
      pluginSourceHash: entry.sourceHash
    });
    const versionHash = methodVersionHash(entry.sourceHash ?? entry.plugin.version, method.localId);
    return Object.freeze({
      // Namespaced with a slash, matching how uploaded algorithms already use
      // "uploads/<name>", so ids stay unambiguous across all three sources.
      id: method.id,
      file: entry.path ?? `${entry.plugin.id}.plugin.json`,
      path: entry.path ?? null,
      uploaded: false,
      trusted: true,
      // This is a declarative, schema-validated source envelope. Engine workers
      // recognise it and run the same interpreter there; it is never evaluated as JS.
      source,
      sourceHash: versionHash,
      versionHash,
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
    });
  });
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
  for (const declaredControl of pairing.controls) {
    const control = typeof declaredControl === "string" ? { id: declaredControl } : declaredControl;
    const controlId = qualify(control.id);
    const method = all.get(controlId);
    if (!method) continue;
    const params = { ...(control.params ?? pairing.controlParams?.[control.id] ?? pairing.controlParams?.[controlId] ?? {}) };
    // A control that reads randomness is only meaningful as a distribution, so it is
    // expanded across the pairing's seed count rather than run once.
    if ("seed" in method.params) {
      for (let seed = 1; seed <= (pairing.seeds ?? 10); seed += 1) {
        runs.push({ kind: "control", id: controlId, params: { ...params, seed }, symbol: control.symbol });
      }
    } else {
      runs.push({ kind: "control", id: controlId, params, symbol: control.symbol });
    }
  }
  return Object.freeze({ strategy: strategyId, runs: Object.freeze(runs) });
}
