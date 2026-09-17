import { PluginMethodSchema } from "../../packages/shared/plugin.js";

// A durable algorithm version needs source_code even when the executable logic
// is a closed rule tree rather than JavaScript. This marker carries only the
// validated method data; workers recognise it and use the same interpreter as
// the plugin registry. It is never evaluated as JavaScript.
export const PLUGIN_METHOD_SOURCE_PREFIX = "stockbot.plugin-method.v1\n";

export function encodePluginMethodSource({ id, method, pluginSourceHash }) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("A plugin method source requires a non-empty id.");
  }
  const parsed = PluginMethodSchema.parse(structuredClone(method));
  if (pluginSourceHash !== undefined && (typeof pluginSourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(pluginSourceHash))) {
    throw new TypeError("Plugin method source hash must be a SHA-256 hex digest.");
  }
  // Carry the bundle revision as data so a change anywhere in a plugin creates a
  // new immutable source version for every method it ships. This is intentionally
  // conservative: cache invalidation is safer than serving a mixed plugin revision.
  return `${PLUGIN_METHOD_SOURCE_PREFIX}${JSON.stringify({ id, method: parsed, pluginSourceHash })}`;
}

export function isPluginMethodSource(source) {
  return typeof source === "string" && source.startsWith(PLUGIN_METHOD_SOURCE_PREFIX);
}

export function decodePluginMethodSource(source) {
  if (!isPluginMethodSource(source)) return null;
  let parsed;
  try {
    parsed = JSON.parse(source.slice(PLUGIN_METHOD_SOURCE_PREFIX.length));
  } catch (cause) {
    const error = new Error("Plugin algorithm version contains invalid JSON.");
    error.code = "PLUGIN_ALGORITHM_SOURCE_INVALID";
    error.cause = cause;
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      typeof parsed.id !== "string" || parsed.id.trim() === "") {
    const error = new Error("Plugin algorithm version is missing its method identity.");
    error.code = "PLUGIN_ALGORITHM_SOURCE_INVALID";
    throw error;
  }
  try {
    if (parsed.pluginSourceHash !== undefined &&
        (typeof parsed.pluginSourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(parsed.pluginSourceHash))) {
      throw new TypeError("pluginSourceHash must be a SHA-256 hex digest");
    }
    return Object.freeze({
      id: parsed.id,
      method: PluginMethodSchema.parse(parsed.method),
      pluginSourceHash: parsed.pluginSourceHash
    });
  } catch (cause) {
    const error = new Error(`Plugin algorithm version is invalid: ${cause.message}`);
    error.code = "PLUGIN_ALGORITHM_SOURCE_INVALID";
    error.cause = cause;
    throw error;
  }
}
