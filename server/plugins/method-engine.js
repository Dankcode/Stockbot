/**
 * Compiles a stockbot.plugin.v1 `method` block into the same `{ name, params, init,
 * signal }` shape the backtest engine and paper broker already consume.
 *
 * "Compiles" means binds, not generates. No source text is produced or executed; the
 * returned `signal` closes over a frozen rule tree and walks it with the interpreter in
 * expression.js. A JSON plugin therefore plugs into the existing engine, fill model,
 * metrics, risk checks, and result cache with no special-casing downstream — from the
 * engine's point of view a compiled plugin method is indistinguishable from a
 * hand-written .js algorithm.
 *
 * Evaluation order per bar mirrors the hand-written strategies exactly:
 *
 *   1. return early while index < warmup
 *   2. advance the seeded PRNG once (whether or not any rule reads it)
 *   3. if long  -> evaluate `exit` rules in order, first match wins
 *   4. if flat  -> evaluate `entry` rules in order, first match wins
 *   5. apply the matched rule's `set` assignments to state
 *
 * The PRNG advances unconditionally so a control's draw sequence depends only on the
 * seed and the bar index, never on the path the strategy happened to take. That is what
 * makes a random control reproducible across parameter sweeps.
 */
import { evaluate, ExpressionError, truthy } from "./expression.js";

const INDICATOR_FUNCTIONS = Object.freeze(new Set(["ema", "sma", "rsi", "atr", "highestHigh", "lowestLow"]));
const MAX_RULES = 32;

export class MethodCompileError extends Error {
  constructor(message, { code = "PLUGIN_METHOD_INVALID", methodId } = {}) {
    super(methodId ? `${methodId}: ${message}` : message);
    this.name = "MethodCompileError";
    this.code = code;
    this.methodId = methodId;
  }
}

/**
 * SplitMix32 finalizer over a monotonic counter. Identical to the mixer used by the
 * hand-written control strategies, so a JSON control and its .js ancestor produce the
 * same trade sequence for the same seed — which is what makes the migration verifiable
 * rather than merely plausible.
 */
function createPrng(seed) {
  let counter = (Math.trunc(Number(seed)) >>> 0) || 1;
  return () => {
    counter = (counter + 0x9e3779b9) >>> 0;
    let mixed = counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    mixed = (mixed ^ (mixed >>> 15)) >>> 0;
    return mixed / 4294967296;
  };
}

function resolvePositiveInteger(value, label, methodId) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1 || Math.trunc(number) !== number) {
    throw new MethodCompileError(`${label} must resolve to a positive integer, got ${value}`, { methodId });
  }
  return number;
}

function evaluateConstants(method, params, methodId) {
  const constants = Object.create(null);
  // Derived constants are evaluated in declaration order and may reference earlier
  // ones, which is how a horizon band expands into a hold span and then a cadence
  // without the plugin repeating the arithmetic in every rule.
  for (const [name, node] of Object.entries(method.derived ?? {})) {
    try {
      constants[name] = evaluate(
        { params, constants, budget: { nodes: 0 } },
        node,
        `derived.${name}`
      );
    } catch (cause) {
      throw new MethodCompileError(`derived constant "${name}" failed: ${cause.message}`, {
        methodId,
        code: cause.code ?? "PLUGIN_DERIVED_INVALID"
      });
    }
  }
  return constants;
}

export function compileMethod(definition, { id } = {}) {
  const methodId = id ?? definition?.id ?? "method";
  const method = definition?.method ?? definition;
  if (!method || typeof method !== "object") {
    throw new MethodCompileError("method block is missing", { methodId });
  }
  if (method.kind !== "rules.v1") {
    throw new MethodCompileError(`unsupported method kind "${method.kind}"`, { methodId, code: "PLUGIN_METHOD_KIND" });
  }

  const entryRules = method.entry ?? [];
  const exitRules = method.exit ?? [];
  if (!Array.isArray(entryRules) || !Array.isArray(exitRules)) {
    throw new MethodCompileError("entry and exit must be arrays of rules", { methodId });
  }
  if (entryRules.length + exitRules.length === 0) {
    throw new MethodCompileError("a method needs at least one entry or exit rule", { methodId });
  }
  if (entryRules.length > MAX_RULES || exitRules.length > MAX_RULES) {
    throw new MethodCompileError(`a method may not exceed ${MAX_RULES} rules per phase`, { methodId });
  }

  const defaultParams = Object.freeze({ ...(definition?.params ?? {}) });
  const indicatorSpecs = Object.entries(method.indicators ?? {});
  for (const [name, spec] of indicatorSpecs) {
    if (!spec || !INDICATOR_FUNCTIONS.has(spec.fn)) {
      throw new MethodCompileError(
        `indicator "${name}" uses unsupported function "${spec?.fn}"`,
        { methodId, code: "PLUGIN_INDICATOR_UNKNOWN" }
      );
    }
  }

  const declaredState = method.state ?? {};

  /**
   * Periods resolve once at init (they depend only on params and derived constants).
   * The SERIES themselves must be re-fetched every bar: the engine hands `signal` an
   * indicator facade whose arrays are truncated to the current index, so caching the
   * array returned on the first call would freeze every indicator at two elements and
   * silently make every rule read NaN. The underlying series is computed once per run
   * and cached by the engine, so re-fetching is a lookup, not a recomputation.
   */
  function resolvePeriods(params, constants) {
    const periods = [];
    for (const [name, spec] of indicatorSpecs) {
      periods.push([
        name,
        spec.fn,
        resolvePositiveInteger(
          evaluate({ params, constants, budget: { nodes: 0 } }, spec.period, `indicators.${name}.period`),
          `indicator "${name}" period`,
          methodId
        )
      ]);
    }
    return periods;
  }

  function bindSeries(periods, indicators) {
    const series = Object.create(null);
    for (const [name, fn, period] of periods) series[name] = indicators[fn](period);
    return series;
  }

  function applyRule(rule, context, state, phase, index) {
    if (!rule.set) return;
    for (const [key, node] of Object.entries(rule.set)) {
      if (!(key in state)) {
        throw new MethodCompileError(
          `${phase} rule ${index} assigns undeclared state key "${key}"`,
          { methodId, code: "PLUGIN_STATE_UNKNOWN" }
        );
      }
      state[key] = evaluate(context, node, `${phase}[${index}].set.${key}`);
    }
  }

  function matchRules(rules, context, state, phase) {
    for (const [index, rule] of rules.entries()) {
      let matched;
      try {
        matched = truthy(evaluate(context, rule.when, `${phase}[${index}].when`));
      } catch (cause) {
        if (cause instanceof ExpressionError) {
          throw new MethodCompileError(`${phase} rule ${index} failed: ${cause.message}`, { methodId, code: cause.code });
        }
        throw cause;
      }
      if (!matched) continue;
      applyRule(rule, context, state, phase, index);
      const action = rule.action ?? (phase === "entry" ? "buy" : "sell");
      if (action === "none") return null;
      const signal = { action, reason: rule.reason ?? `${methodId} ${phase} rule ${index}` };
      if (rule.confidence !== undefined) {
        const confidence = Number(evaluate(context, rule.confidence, `${phase}[${index}].confidence`));
        if (Number.isFinite(confidence)) signal.confidence = confidence;
      }
      return signal;
    }
    return null;
  }

  const algorithm = {
    name: definition?.name ?? methodId,
    author: definition?.author,
    description: definition?.description,
    params: defaultParams,

    init(context) {
      const params = context?.params ?? defaultParams;
      const constants = evaluateConstants(method, params, methodId);
      const warmup = method.warmup === undefined
        ? 1
        : Math.max(1, Math.trunc(Number(evaluate({ params, constants, budget: { nodes: 0 } }, method.warmup, "warmup"))));

      const state = Object.create(null);
      for (const [key, node] of Object.entries(declaredState)) {
        state[key] = evaluate({ params, constants, budget: { nodes: 0 } }, node, `state.${key}`);
      }

      const seedNode = method.seed;
      const seed = seedNode === undefined
        ? null
        : Number(evaluate({ params, constants, budget: { nodes: 0 } }, seedNode, "seed"));

      return {
        __plugin: {
          constants,
          warmup,
          periods: resolvePeriods(params, constants),
          prng: seed === null ? null : createPrng(seed),
          random: 0
        },
        ...state
      };
    },

    signal(context) {
      const runtime = context.state?.__plugin;
      if (!runtime) {
        throw new MethodCompileError("plugin state was not initialised by init()", { methodId, code: "PLUGIN_STATE_MISSING" });
      }
      const { index, bar, position, research } = context;
      if (index < runtime.warmup) return null;

      // Advance the PRNG exactly once per evaluated bar, before any rule can branch on
      // it, so the draw sequence depends only on the seed and the bar index rather than
      // on the path the strategy took. Deliberately after the warmup guard, matching the
      // hand-written controls: advancing during warmup would shift every later draw and
      // silently change the trade sequence for a given seed.
      if (runtime.prng) runtime.random = runtime.prng();

      const evaluationContext = {
        index,
        params: context.params,
        constants: runtime.constants,
        state: context.state,
        series: bindSeries(runtime.periods, context.indicators),
        bar,
        position,
        research: research ?? null,
        vars: {
          index,
          barCount: context.bars?.length ?? index + 1,
          barsSinceEntry: position.entryIndex >= 0 ? index - position.entryIndex : -1,
          barsRemaining: -1,
          random: runtime.random
        },
        budget: { nodes: 0 }
      };

      return position.qty > 0
        ? matchRules(exitRules, evaluationContext, context.state, "exit")
        : matchRules(entryRules, evaluationContext, context.state, "entry");
    }
  };

  return Object.freeze(algorithm);
}

export function compilePluginMethods(plugin) {
  const compiled = [];
  for (const definition of plugin.methods ?? []) {
    compiled.push(Object.freeze({
      id: definition.id,
      role: definition.role ?? "strategy",
      controlFor: definition.controlFor ?? null,
      pluginId: plugin.id,
      algorithm: compileMethod(definition, { id: definition.id })
    }));
  }
  return Object.freeze(compiled);
}
