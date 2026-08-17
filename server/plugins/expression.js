/**
 * Deterministic expression evaluator for stockbot.plugin.v1 methods.
 *
 * This is the piece that lets a shared plugin describe trading logic as DATA rather
 * than JavaScript. A plugin you download from a stranger contains no code: it contains
 * a frozen tree of operators that this file walks. There is no `eval`, no `new
 * Function`, no dynamic import, and no string is ever compiled. The worst a malicious
 * expression can do is return a wrong number or exhaust its own node budget.
 *
 * That is a stronger guarantee than the .js algorithm sandbox provides. The sandbox is
 * a capability gate over real JavaScript and its own docs call it "not a formal security
 * boundary for malicious JavaScript". An interpreter over a closed operator set is.
 *
 * Determinism is equally load-bearing. Stockbot caches backtests by algorithm version,
 * params, symbol, window, bar hash, and fill model, so an expression that consulted the
 * clock or a real RNG would make cached and fresh runs disagree. Every operator here is
 * a pure function of the evaluation context; randomness is supplied by the caller as a
 * per-bar draw from a seeded PRNG, never generated in here.
 */

const MAX_NODES = 4_000;

/**
 * Nesting depth is capped separately from total node count, and much lower, because the
 * two protect against different things. The node budget bounds how much WORK one
 * evaluation may do; the depth cap bounds how much NATIVE STACK it may consume.
 *
 * Without this, a plugin containing a few thousand nested `{"add": [...]}` nodes crashes
 * the process with an unrecoverable RangeError before the node budget is ever consulted
 * — the recursion dies first. A crash is a worse failure than a rejection, and in a
 * format designed to be downloaded from strangers it is a denial-of-service primitive.
 * 64 levels is far beyond any legible rule and far below the native limit.
 */
const MAX_DEPTH = 64;

export class ExpressionError extends Error {
  constructor(message, { code = "PLUGIN_EXPRESSION_INVALID", path } = {}) {
    super(path ? `${message} (at ${path})` : message);
    this.name = "ExpressionError";
    this.code = code;
    this.path = path;
  }
}

const BAR_FIELDS = Object.freeze(new Set(["open", "high", "low", "close", "volume", "time"]));
const POSITION_FIELDS = Object.freeze(new Set(["qty", "entryPrice", "entryIndex"]));
const VARS = Object.freeze(new Set(["index", "barCount", "barsSinceEntry", "barsRemaining", "random"]));
const RESEARCH_FIELDS = Object.freeze(new Set(["available", "sentiment", "confidence", "snapshotId", "ageMs"]));

/** Operators taking a fixed or variadic list of numeric operands. */
const NUMERIC_OPS = Object.freeze({
  add: (values) => values.reduce((total, value) => total + value, 0),
  sub: (values) => values.slice(1).reduce((total, value) => total - value, values[0]),
  mul: (values) => values.reduce((total, value) => total * value, 1),
  div: (values) => values.slice(1).reduce((total, value) => (value === 0 ? Number.NaN : total / value), values[0]),
  mod: (values) => (values[1] === 0 ? Number.NaN : ((values[0] % values[1]) + values[1]) % values[1]),
  pow: (values) => values[0] ** values[1],
  min: (values) => Math.min(...values),
  max: (values) => Math.max(...values),
  abs: (values) => Math.abs(values[0]),
  neg: (values) => -values[0],
  floor: (values) => Math.floor(values[0]),
  ceil: (values) => Math.ceil(values[0]),
  round: (values) => Math.round(values[0]),
  trunc: (values) => Math.trunc(values[0])
});

const ARITY = Object.freeze({
  sub: [2, 8], div: [2, 8], mod: [2, 2], pow: [2, 2],
  abs: [1, 1], neg: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 1], trunc: [1, 1],
  add: [1, 16], mul: [1, 16], min: [1, 16], max: [1, 16]
});

const COMPARISONS = Object.freeze({
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b
});

export const EXPRESSION_OPERATORS = Object.freeze([
  ...Object.keys(NUMERIC_OPS),
  ...Object.keys(COMPARISONS),
  "and", "or", "not", "if",
  "crossesAbove", "crossesBelow",
  "param", "const", "state", "bar", "position", "series", "var", "research", "lookup"
]);

function fail(message, path, code) {
  throw new ExpressionError(message, { path, code });
}

/**
 * Series access is the only place lookahead could sneak into a plugin, so it is
 * centralised here: an offset is always subtracted, never added, and reading before the
 * start of the window yields NaN rather than wrapping to the end of the array.
 */
function seriesValue(context, name, offset, path) {
  const series = context.series?.[name];
  if (!series) fail(`Unknown indicator series "${name}"`, path, "PLUGIN_SERIES_UNKNOWN");
  const at = context.index - offset;
  if (at < 0 || at >= series.length) return Number.NaN;
  const value = series[at];
  return typeof value === "number" ? value : Number.NaN;
}

function crossed(context, node, path, direction, depth = 0) {
  const operands = node[direction === "up" ? "crossesAbove" : "crossesBelow"];
  if (!Array.isArray(operands) || operands.length !== 2) {
    fail(`${direction === "up" ? "crossesAbove" : "crossesBelow"} needs exactly two operands`, path);
  }
  const [left, right] = operands;
  const nowLeft = evaluateOperand(context, left, 0, `${path}.0`, depth);
  const nowRight = evaluateOperand(context, right, 0, `${path}.1`, depth);
  const wasLeft = evaluateOperand(context, left, 1, `${path}.0`, depth);
  const wasRight = evaluateOperand(context, right, 1, `${path}.1`, depth);
  if (![nowLeft, nowRight, wasLeft, wasRight].every(Number.isFinite)) return false;
  return direction === "up"
    ? wasLeft <= wasRight && nowLeft > nowRight
    : wasLeft >= wasRight && nowLeft < nowRight;
}

/**
 * Evaluates an operand with an extra bar offset applied to any series reference beneath
 * it, which is what makes `crossesAbove` work on arbitrary sub-expressions rather than
 * only on bare series names.
 */
function evaluateOperand(context, node, extraOffset, path, depth = 0) {
  if (extraOffset === 0) return evaluate(context, node, path, depth + 1);
  if (typeof node === "string") return seriesValue(context, node, extraOffset, path);
  if (node && typeof node === "object" && typeof node.series === "string") {
    return seriesValue(context, node.series, Number(node.offset ?? 0) + extraOffset, path);
  }
  return evaluate({ ...context, index: context.index - extraOffset }, node, path, depth + 1);
}

export function evaluate(context, node, path = "$", depth = 0) {
  if (context.budget === undefined) context.budget = { nodes: 0 };
  context.budget.nodes += 1;
  if (context.budget.nodes > MAX_NODES) {
    fail(`Expression exceeded the ${MAX_NODES}-node evaluation budget`, path, "PLUGIN_EXPRESSION_BUDGET");
  }
  if (depth > MAX_DEPTH) {
    fail(`Expression exceeded the ${MAX_DEPTH}-level nesting limit`, path, "PLUGIN_EXPRESSION_DEPTH");
  }
  // Bind the current depth so the many `evaluate(context, child, path)` call sites below
  // do not each have to thread it through by hand and cannot forget to.
  const recurse = (childNode, childPath, offsetContext = context) =>
    evaluate(offsetContext, childNode, childPath, depth + 1);

  if (node === null || node === undefined) return null;
  if (typeof node === "number") {
    if (!Number.isFinite(node)) fail("Numeric literals must be finite", path);
    return node;
  }
  if (typeof node === "boolean") return node;
  // A bare string is shorthand for a series reference — the common case by far.
  if (typeof node === "string") return seriesValue(context, node, 0, path);
  if (Array.isArray(node)) fail("Expression nodes must be objects, numbers, booleans, or series names", path);
  if (typeof node !== "object") fail(`Unsupported expression node of type ${typeof node}`, path);

  const keys = Object.keys(node);
  if (keys.length !== 1) {
    fail(`Expression nodes need exactly one operator key, found ${keys.length ? keys.join(", ") : "none"}`, path);
  }
  const [op] = keys;
  const operand = node[op];

  switch (op) {
    case "value": {
      if (typeof operand === "number" || typeof operand === "boolean" || typeof operand === "string") return operand;
      fail("value must be a number, boolean, or string literal", path);
      break;
    }
    case "param": {
      const value = context.params?.[operand];
      if (value === undefined) fail(`Unknown param "${operand}"`, path, "PLUGIN_PARAM_UNKNOWN");
      return value;
    }
    case "const": {
      if (!context.constants || !(operand in context.constants)) {
        fail(`Unknown derived constant "${operand}"`, path, "PLUGIN_CONST_UNKNOWN");
      }
      return context.constants[operand];
    }
    case "state": {
      if (!context.state || !(operand in context.state)) {
        fail(`Unknown state key "${operand}"`, path, "PLUGIN_STATE_UNKNOWN");
      }
      return context.state[operand];
    }
    case "bar": {
      if (!BAR_FIELDS.has(operand)) fail(`Unknown bar field "${operand}"`, path);
      if (!context.bar) fail("bar is not available in this evaluation phase", path, "PLUGIN_PHASE_INVALID");
      return context.bar[operand];
    }
    case "position": {
      if (!POSITION_FIELDS.has(operand)) fail(`Unknown position field "${operand}"`, path);
      if (!context.position) fail("position is not available in this evaluation phase", path, "PLUGIN_PHASE_INVALID");
      return context.position[operand];
    }
    case "series": {
      if (typeof operand === "string") return seriesValue(context, operand, 0, path);
      if (operand && typeof operand === "object" && typeof operand.name === "string") {
        const offset = Number(operand.offset ?? 0);
        if (!Number.isInteger(offset) || offset < 0 || offset > 512) {
          fail("series offset must be an integer from 0 through 512", path);
        }
        return seriesValue(context, operand.name, offset, path);
      }
      fail("series takes a name or { name, offset }", path);
      break;
    }
    case "var": {
      if (!VARS.has(operand)) fail(`Unknown variable "${operand}"`, path);
      if (context.vars === undefined || context.vars[operand] === undefined) {
        fail(`Variable "${operand}" is not available in this evaluation phase`, path, "PLUGIN_PHASE_INVALID");
      }
      return context.vars[operand];
    }
    case "research": {
      if (!RESEARCH_FIELDS.has(operand)) fail(`Unknown research field "${operand}"`, path);
      const frame = context.research;
      if (operand === "available") return Boolean(frame && frame.status === "available");
      if (!frame || frame.status !== "available") return operand === "confidence" ? Number.NaN : null;
      const summary = frame.snapshot.summary;
      if (operand === "sentiment") return summary.sentiment;
      if (operand === "confidence") return Number(summary.confidence);
      if (operand === "snapshotId") return frame.snapshot.id;
      if (operand === "ageMs") return Number(frame.decisionAt) - Number(frame.snapshot.availableAt);
      break;
    }
    case "not": return !truthy(recurse(operand, `${path}.not`));
    case "and": {
      requireArray(operand, path, 1, 16);
      for (const [position, child] of operand.entries()) {
        if (!truthy(recurse(child, `${path}.and[${position}]`))) return false;
      }
      return true;
    }
    case "or": {
      requireArray(operand, path, 1, 16);
      for (const [position, child] of operand.entries()) {
        if (truthy(recurse(child, `${path}.or[${position}]`))) return true;
      }
      return false;
    }
    case "if": {
      requireArray(operand, path, 3, 3);
      return truthy(recurse(operand[0], `${path}.if[0]`))
        ? recurse(operand[1], `${path}.if[1]`)
        : recurse(operand[2], `${path}.if[2]`);
    }
    case "crossesAbove": return crossed(context, node, `${path}.crossesAbove`, "up", depth);
    case "crossesBelow": return crossed(context, node, `${path}.crossesBelow`, "down", depth);
    case "lookup": {
      if (!operand || typeof operand !== "object" || !operand.map || typeof operand.map !== "object") {
        fail("lookup takes { map, key, default? }", path);
      }
      const key = String(recurse(operand.key, `${path}.lookup.key`));
      if (Object.hasOwn(operand.map, key)) return recurse(operand.map[key], `${path}.lookup.map.${key}`);
      if (operand.default === undefined) {
        fail(`lookup key "${key}" is not in the map and no default was supplied`, path, "PLUGIN_LOOKUP_MISS");
      }
      return recurse(operand.default, `${path}.lookup.default`);
    }
    default: break;
  }

  if (COMPARISONS[op]) {
    requireArray(operand, path, 2, 2);
    const left = recurse(operand[0], `${path}.${op}[0]`);
    const right = recurse(operand[1], `${path}.${op}[1]`);
    // NaN propagates as false rather than throwing: an indicator inside its warmup
    // window is legitimately undefined, and a rule referencing it should simply not
    // fire, exactly as the hand-written JS strategies behave.
    if (typeof left === "number" && typeof right === "number" && (Number.isNaN(left) || Number.isNaN(right))) {
      return false;
    }
    return COMPARISONS[op](left, right);
  }

  if (NUMERIC_OPS[op]) {
    const [minArity, maxArity] = ARITY[op];
    const operands = Array.isArray(operand) ? operand : [operand];
    requireArray(operands, path, minArity, maxArity);
    const values = operands.map((child, position) => {
      const value = recurse(child, `${path}.${op}[${position}]`);
      return typeof value === "number" ? value : Number.NaN;
    });
    return NUMERIC_OPS[op](values);
  }

  fail(`Unknown expression operator "${op}"`, path, "PLUGIN_OPERATOR_UNKNOWN");
  return null;
}

function requireArray(value, path, minLength, maxLength) {
  if (!Array.isArray(value)) fail("Operator expects an array of operands", path);
  if (value.length < minLength || value.length > maxLength) {
    fail(`Operator expects between ${minLength} and ${maxLength} operands, got ${value.length}`, path);
  }
}

export function truthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.length > 0;
  return Boolean(value);
}

/**
 * Static walk used at install time. Catches unknown operators, malformed nodes, and
 * references to indicator series or state keys the method never declares — so a broken
 * plugin fails at `plugin validate` with a path, not at bar 4,000 of a backtest.
 */
export function collectExpressionReferences(node, path = "$", found = { series: new Set(), params: new Set(), constants: new Set(), state: new Set(), research: false, random: false }, depth = 0) {
  if (depth > MAX_DEPTH) {
    fail(`Expression exceeded the ${MAX_DEPTH}-level nesting limit`, path, "PLUGIN_EXPRESSION_DEPTH");
  }
  if (node === null || node === undefined) return found;
  if (typeof node === "string") { found.series.add(node); return found; }
  if (typeof node === "number" || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    node.forEach((child, position) => collectExpressionReferences(child, `${path}[${position}]`, found, depth + 1));
    return found;
  }
  if (typeof node !== "object") fail(`Unsupported expression node of type ${typeof node}`, path);

  const keys = Object.keys(node);
  if (keys.length !== 1) fail(`Expression nodes need exactly one operator key, found ${keys.length}`, path);
  const [op] = keys;
  const operand = node[op];
  if (!EXPRESSION_OPERATORS.includes(op) && op !== "value") {
    fail(`Unknown expression operator "${op}"`, path, "PLUGIN_OPERATOR_UNKNOWN");
  }

  if (op === "value") return found;
  if (op === "param") { found.params.add(String(operand)); return found; }
  if (op === "const") { found.constants.add(String(operand)); return found; }
  if (op === "state") { found.state.add(String(operand)); return found; }
  if (op === "series") {
    if (typeof operand === "string") found.series.add(operand);
    else if (operand && typeof operand.name === "string") found.series.add(operand.name);
    else fail("series takes a name or { name, offset }", path);
    return found;
  }
  if (op === "bar") {
    if (!BAR_FIELDS.has(operand)) fail(`Unknown bar field "${operand}"`, path);
    return found;
  }
  if (op === "position") {
    if (!POSITION_FIELDS.has(operand)) fail(`Unknown position field "${operand}"`, path);
    return found;
  }
  if (op === "var") {
    if (!VARS.has(operand)) fail(`Unknown variable "${operand}"`, path);
    if (operand === "random") found.random = true;
    return found;
  }
  if (op === "research") {
    if (!RESEARCH_FIELDS.has(operand)) fail(`Unknown research field "${operand}"`, path);
    found.research = true;
    return found;
  }
  if (op === "lookup") {
    if (!operand || typeof operand !== "object" || !operand.map) fail("lookup takes { map, key, default? }", path);
    collectExpressionReferences(operand.key, `${path}.lookup.key`, found, depth + 1);
    for (const [key, child] of Object.entries(operand.map)) {
      collectExpressionReferences(child, `${path}.lookup.map.${key}`, found, depth + 1);
    }
    if (operand.default !== undefined) collectExpressionReferences(operand.default, `${path}.lookup.default`, found, depth + 1);
    return found;
  }

  collectExpressionReferences(operand, `${path}.${op}`, found, depth + 1);
  return found;
}
