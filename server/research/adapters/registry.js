function adapterError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("Research adapters must be objects.");
  }
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/.test(String(adapter.id ?? ""))) {
    throw new TypeError("Research adapter id is invalid.");
  }
  if (!new Set(["scrape", "summarize"]).has(adapter.kind)) {
    throw new TypeError(`Research adapter ${adapter.id} has an invalid kind.`);
  }
  if (typeof adapter.version !== "string" || adapter.version.trim() === "") {
    throw new TypeError(`Research adapter ${adapter.id} requires a version.`);
  }
  if (typeof adapter.execute !== "function") {
    throw new TypeError(`Research adapter ${adapter.id} requires execute().`);
  }
  return adapter;
}

/**
 * Code-owned adapter registry. Plan adapter ids are lookup keys only; they can
 * never become import paths, package names, executables, or shell commands.
 */
export function createResearchAdapterRegistry(initialAdapters = []) {
  const adapters = new Map();

  const registry = {
    register(input) {
      const adapter = validateAdapter(input);
      if (adapters.has(adapter.id)) {
        throw adapterError(`Research adapter ${adapter.id} is already registered.`, "RESEARCH_ADAPTER_DUPLICATE");
      }
      adapters.set(adapter.id, Object.freeze(adapter));
      return adapter;
    },

    resolve(kind, id) {
      const adapter = adapters.get(id);
      if (!adapter || adapter.kind !== kind) {
        throw adapterError(`Research ${kind} adapter ${id} is not registered.`, "RESEARCH_ADAPTER_NOT_FOUND", {
          kind,
          id
        });
      }
      return adapter;
    },

    list() {
      return Object.freeze(
        [...adapters.values()].map(({ id, kind, version, available = true }) =>
          Object.freeze({ id, kind, version, available: Boolean(available) })
        )
      );
    },

    validatePlan(plan) {
      for (const step of plan.steps) registry.resolve(step.kind, step.adapter);
      return plan;
    }
  };

  for (const adapter of initialAdapters) registry.register(adapter);
  return Object.freeze(registry);
}

