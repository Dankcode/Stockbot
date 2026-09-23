/**
 * Experiment planning.
 *
 * An *experiment* is one strategy arm plus the control arms it has to beat, resolved
 * against one symbol and one window. It is the unit the CONTROL_GROUP.md procedure
 * describes, and until now the only thing that encoded it was prose plus the `pairings`
 * block in a plugin file, which nothing executed.
 *
 * Three properties this module is responsible for, because getting any of them wrong
 * turns a comparison into a coincidence:
 *
 * 1. **Congruence.** A control inherits the strategy's symbol, range, interval and fill
 *    model, and the `controlParams` the pairing declares. A monthly strategy compared
 *    against a daily control measures turnover, not skill.
 * 2. **Distribution, not draw.** A control that reads randomness is expanded across
 *    `seeds` runs. One seed is an anecdote; CONTROL_GROUP.md documents a ten-seed spread
 *    on the same series running from -31% to +160%.
 * 3. **Deduplication.** Buy-and-hold on AAPL over 1Y is the same run whichever strategy
 *    named it. Arms are keyed on (algorithmId, params) and executed once, then shared by
 *    every group that references them. Three strategies sharing a 20-seed random control
 *    is 23 runs, not 63.
 *
 * This module is pure. It resolves and validates a plan; it never fetches bars, touches
 * the database, or runs the engine. `runner.js` executes a plan through an injected
 * executor, which is what lets the same plan run against the loopback API, an in-process
 * engine, or a test double.
 */

const MAX_STRATEGIES = 32;
const MAX_CONTROLS_PER_STRATEGY = 16;
const MAX_SEEDS = 100;
const MAX_ARMS = 1_024;

export class ExperimentPlanError extends Error {
  constructor(message, { code = "EXPERIMENT_PLAN_INVALID", detail } = {}) {
    super(message);
    this.name = "ExperimentPlanError";
    this.code = code;
    this.detail = detail;
  }
}

/** Stable stringify so two params objects that differ only in key order share an arm. */
function stableParams(params) {
  const entries = Object.entries(params ?? {})
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

function armKey(algorithmId, params, symbol) {
  return `${algorithmId}@${symbol}::${stableParams(params)}`;
}

/**
 * Arm ids are readable rather than opaque: they end up in report tables, session names
 * and CLI output, and an operator reading "random-entry#seed=7" learns more from it than
 * from a UUID.
 */
function armLabel(algorithmId, params, symbol, planSymbol) {
  const tail = Object.entries(params ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const target = symbol === planSymbol ? "" : `@${symbol}`;
  return tail ? `${algorithmId}${target}#${tail}` : `${algorithmId}${target}`;
}

function qualify(reference, pluginId) {
  const text = String(reference ?? "").trim();
  if (!text) throw new ExperimentPlanError("A method reference cannot be empty.");
  return text.includes("/") || !pluginId ? text : `${pluginId}/${text}`;
}

/**
 * Indexes the registry once. Accepts either the algorithm-registry descriptor shape
 * (`{ id, name, params, plugin }`) or the plugin-registry method shape
 * (`{ id, name, params, role, pluginId }`), because the CLI reads the former over HTTP
 * and the offline harness reads the latter straight off disk.
 */
export function indexMethods(methods) {
  const index = new Map();
  for (const method of methods ?? []) {
    if (!method?.id) continue;
    index.set(method.id, Object.freeze({
      id: method.id,
      name: method.name ?? method.id,
      params: Object.freeze({ ...(method.params ?? {}) }),
      role: method.role ?? method.plugin?.role ?? "strategy",
      horizon: method.horizon ?? method.plugin?.horizon ?? "none",
      pluginId: method.pluginId ?? method.plugin?.id ?? null,
      controlFor: method.controlFor ?? method.plugin?.controlFor ?? null
    }));
  }
  return index;
}

/**
 * Collects every pairing declared by every loaded plugin, keyed by the *qualified*
 * strategy id. A pairing written as `{"strategy": "ema-momentum"}` inside base-methods
 * resolves to `base-methods/ema-momentum`, so a caller never has to know which plugin a
 * method came from to find its controls.
 */
export function indexPairings(plugins) {
  const index = new Map();
  for (const entry of plugins ?? []) {
    const pluginId = entry.plugin?.id ?? entry.id;
    for (const pairing of entry.pairings ?? []) {
      index.set(qualify(pairing.strategy, pluginId), Object.freeze({
        ...pairing,
        pluginId,
        strategy: qualify(pairing.strategy, pluginId),
        controls: Object.freeze(pairing.controls.map((control) => {
          if (typeof control === "string") return qualify(control, pluginId);
          return Object.freeze({ ...control, id: qualify(control.id, pluginId) });
        })),
        controlParams: Object.freeze(
          Object.fromEntries(
            Object.entries(pairing.controlParams ?? {}).map(([key, value]) => [qualify(key, pluginId), value])
          )
        )
      }));
    }
  }
  return index;
}

/**
 * Resolves the controls for one strategy. Explicit `controls` from the caller win — that
 * is the manual path, where the operator chose the comparison themselves. With no
 * explicit list the plugin's declared pairing is used, which is the automated path.
 * A strategy with neither is an error rather than a silent single-arm run: an
 * uncontrolled backtest is exactly the artefact this whole subsystem exists to prevent.
 */
export function resolveControls({ strategyId, explicitControls, pairings, seeds }) {
  if (Array.isArray(explicitControls) && explicitControls.length > 0) {
    return {
      source: "manual",
      seeds,
      controls: explicitControls.map((control) =>
        typeof control === "string" ? { id: control, params: {} } : { id: control.id, params: control.params ?? {}, symbol: control.symbol }
      ),
      notes: null
    };
  }
  const pairing = pairings.get(strategyId);
  if (!pairing) {
    throw new ExperimentPlanError(
      `Strategy "${strategyId}" declares no pairing and no controls were supplied. ` +
      "Pass --control explicitly, or add a pairings entry to the plugin.",
      { code: "EXPERIMENT_CONTROLS_MISSING" }
    );
  }
  return {
    source: "pairing",
    seeds: seeds ?? pairing.seeds ?? 10,
    controls: pairing.controls.map((control) => {
      const id = typeof control === "string" ? control : control.id;
      return { id, params: control.params ?? pairing.controlParams?.[id] ?? {}, symbol: control.symbol };
    }),
    notes: pairing.notes ?? null
  };
}

/**
 * Builds the executable plan.
 *
 * `selection.controls` is deliberately tri-state:
 *   - omitted / "auto"  -> resolve from plugin pairings (automated)
 *   - an array          -> exactly these controls (manual)
 *   - []                -> rejected, see resolveControls
 */
export function buildExperimentPlan({
  methods,
  plugins = [],
  selection,
  now = Date.now()
}) {
  const index = methods instanceof Map ? methods : indexMethods(methods);
  const pairings = plugins instanceof Map ? plugins : indexPairings(plugins);

  const symbol = String(selection?.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9./-]{0,31}$/.test(symbol)) {
    throw new ExperimentPlanError(`Invalid symbol: ${selection?.symbol}`, { code: "EXPERIMENT_SYMBOL_INVALID" });
  }
  const range = String(selection?.range ?? "1Y").trim().toUpperCase();

  const requested = (selection?.strategies ?? []).map((entry) =>
    typeof entry === "string" ? { id: entry, params: {} } : { id: entry.id, params: entry.params ?? {} }
  );
  if (requested.length === 0) {
    throw new ExperimentPlanError("An experiment needs at least one strategy.", { code: "EXPERIMENT_NO_STRATEGY" });
  }
  if (requested.length > MAX_STRATEGIES) {
    throw new ExperimentPlanError(
      `This selection names ${requested.length} strategies, over the ${MAX_STRATEGIES} cap. ` +
      "Name the strategies you want with --strategy, or narrow --all-strategies with --plugin.",
      { code: "EXPERIMENT_TOO_MANY_STRATEGIES" }
    );
  }

  const explicitControls = selection?.controls === "auto" ? null : selection?.controls ?? null;
  const seeds = selection?.seeds == null ? null : Math.trunc(Number(selection.seeds));
  if (seeds !== null && (!Number.isInteger(seeds) || seeds < 1 || seeds > MAX_SEEDS)) {
    throw new ExperimentPlanError(`seeds must be an integer from 1 to ${MAX_SEEDS}.`);
  }

  /** Arms are interned here so identical runs across groups execute once. */
  const arms = new Map();
  const intern = (algorithmId, params, kind, targetSymbol = symbol) => {
    const normalizedSymbol = String(targetSymbol).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9./-]{0,31}$/.test(normalizedSymbol)) {
      throw new ExperimentPlanError(`Invalid control symbol: ${targetSymbol}`, { code: "EXPERIMENT_SYMBOL_INVALID" });
    }
    const key = armKey(algorithmId, params, normalizedSymbol);
    const existing = arms.get(key);
    if (existing) {
      // A method reached as both a strategy and somebody's control stays a strategy —
      // the stronger claim wins, and the report needs it in the strategy column.
      if (kind === "strategy" && existing.kind === "control") {
        arms.set(key, Object.freeze({ ...existing, kind: "strategy" }));
        return arms.get(key);
      }
      return existing;
    }
    const method = index.get(algorithmId);
    if (!method) {
      throw new ExperimentPlanError(`Unknown method: ${algorithmId}`, { code: "EXPERIMENT_METHOD_UNKNOWN" });
    }
    const arm = Object.freeze({
      key,
      id: armLabel(algorithmId, params, normalizedSymbol, symbol),
      algorithmId,
      symbol: normalizedSymbol,
      name: method.name,
      kind,
      role: method.role,
      horizon: method.horizon,
      params: Object.freeze({ ...params })
    });
    arms.set(key, arm);
    return arm;
  };

  const groups = requested.map((strategy) => {
    const method = index.get(strategy.id);
    if (!method) {
      throw new ExperimentPlanError(`Unknown method: ${strategy.id}`, { code: "EXPERIMENT_METHOD_UNKNOWN" });
    }
    if (method.role !== "strategy") {
      throw new ExperimentPlanError(
        `"${strategy.id}" has role "${method.role}" and cannot be the treatment arm of an experiment.`,
        { code: "EXPERIMENT_ROLE_INVALID" }
      );
    }
    const resolved = resolveControls({
      strategyId: strategy.id,
      explicitControls,
      pairings,
      seeds
    });
    if (resolved.controls.length > MAX_CONTROLS_PER_STRATEGY) {
      throw new ExperimentPlanError(`A strategy may not name more than ${MAX_CONTROLS_PER_STRATEGY} controls.`);
    }

    // Intern the strategy before its controls so `plan.arms` is ordered
    // strategy-then-controls. Anything that takes the first N arms — a compare link
    // capped at four sessions, a truncated progress log — otherwise shows four controls
    // and omits the treatment arm, which is the one row a reader actually wants.
    const strategyArm = intern(strategy.id, strategy.params, "strategy");

    const controlArms = [];
    for (const control of resolved.controls) {
      const controlMethod = index.get(control.id);
      if (!controlMethod) {
        throw new ExperimentPlanError(`Unknown control: ${control.id}`, { code: "EXPERIMENT_METHOD_UNKNOWN" });
      }
      // A control whose defaults include a seed is only meaningful as a distribution, so
      // it fans out. A control the caller pinned to one seed explicitly does not — that
      // is a deliberate single-path comparison and overriding it would be surprising.
      const seedable = Object.hasOwn(controlMethod.params, "seed") && !Object.hasOwn(control.params ?? {}, "seed");
      if (seedable) {
        for (let seed = 1; seed <= resolved.seeds; seed += 1) {
          controlArms.push(intern(control.id, { ...control.params, seed }, "control", control.symbol));
        }
      } else {
        controlArms.push(intern(control.id, control.params ?? {}, "control", control.symbol));
      }
    }

    return Object.freeze({
      strategy: strategyArm,
      controls: Object.freeze(controlArms),
      controlSource: resolved.source,
      seeds: resolved.seeds,
      notes: resolved.notes
    });
  });

  const armList = Object.freeze([...arms.values()]);
  if (armList.length > MAX_ARMS) {
    throw new ExperimentPlanError(`This selection expands to ${armList.length} arms, over the ${MAX_ARMS} cap.`);
  }

  return Object.freeze({
    kind: "stockbot.experiment.v1",
    symbol,
    range,
    createdAt: now,
    fillModel: Object.freeze({ ...(selection?.fillModel ?? {}) }),
    researchPlanId: selection?.researchPlanId ?? null,
    groups: Object.freeze(groups),
    arms: armList,
    /** What a naive per-group expansion would have cost, kept so the CLI can show it. */
    savedRuns: groups.reduce((sum, group) => sum + 1 + group.controls.length, 0) - armList.length
  });
}
