export const FORBIDDEN_ALGORITHM_IDENTIFIERS = Object.freeze([
  "import",
  "require",
  "process",
  "globalThis",
  "eval",
  "Function"
]);

export class AlgorithmValidationError extends Error {
  constructor(message, { code = "ALGORITHM_INVALID", file, identifier } = {}) {
    super(message);
    this.name = "AlgorithmValidationError";
    this.code = code;
    this.file = file;
    this.identifier = identifier;
  }
}

/*
 * Masks comments and literal bodies while preserving executable template
 * expressions. This is intentionally conservative; it is a capability gate,
 * not a general-purpose JavaScript parser.
 */
function maskNonExecutable(source) {
  const output = Array.from(source, () => " ");
  let cursor = 0;

  const copyCode = (untilTemplateBrace = false) => {
    let braceDepth = untilTemplateBrace ? 1 : 0;
    while (cursor < source.length) {
      const character = source[cursor];
      const next = source[cursor + 1];

      if (untilTemplateBrace && character === "}") {
        braceDepth -= 1;
        output[cursor] = character;
        cursor += 1;
        if (braceDepth === 0) return;
        continue;
      }
      if (untilTemplateBrace && character === "{") {
        braceDepth += 1;
        output[cursor] = character;
        cursor += 1;
        continue;
      }
      if (character === "/" && next === "/") {
        cursor += 2;
        while (cursor < source.length && source[cursor] !== "\n") cursor += 1;
        continue;
      }
      if (character === "/" && next === "*") {
        cursor += 2;
        while (cursor < source.length && !(source[cursor] === "*" && source[cursor + 1] === "/")) cursor += 1;
        cursor = Math.min(source.length, cursor + 2);
        continue;
      }
      if (character === "'" || character === '"') {
        const quote = character;
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === "\\") cursor += 2;
          else if (source[cursor] === quote) {
            cursor += 1;
            break;
          } else cursor += 1;
        }
        continue;
      }
      if (character === "`") {
        cursor += 1;
        while (cursor < source.length) {
          if (source[cursor] === "\\") {
            cursor += 2;
          } else if (source[cursor] === "`") {
            cursor += 1;
            break;
          } else if (source[cursor] === "$" && source[cursor + 1] === "{") {
            output[cursor] = "$";
            output[cursor + 1] = "{";
            cursor += 2;
            copyCode(true);
          } else {
            cursor += 1;
          }
        }
        continue;
      }

      output[cursor] = character;
      cursor += 1;
    }
  };

  copyCode(false);
  return output.join("");
}

function plainRecord(value) {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]";
}

export function defaultExportSpan(source, { file = "algorithm.js" } = {}) {
  const executable = maskNonExecutable(source);
  const match = /\bexport\s+default\b/.exec(executable);
  if (!match) {
    throw new AlgorithmValidationError(`${file} must export a default algorithm object.`, { file });
  }
  return Object.freeze({ index: match.index, length: match[0].length });
}

export function validateAlgorithmSource(source, { file = "algorithm.js", maxBytes = 500_000 } = {}) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new AlgorithmValidationError(`${file} must contain JavaScript source.`, { file });
  }
  if (Buffer.byteLength(source, "utf8") > maxBytes) {
    throw new AlgorithmValidationError(`${file} exceeds the ${maxBytes}-byte source limit.`, {
      code: "ALGORITHM_TOO_LARGE",
      file
    });
  }

  const executable = maskNonExecutable(source);
  for (const identifier of FORBIDDEN_ALGORITHM_IDENTIFIERS) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${identifier.replace("$", "\\$")}([^A-Za-z0-9_$]|$)`);
    if (pattern.test(executable)) {
      throw new AlgorithmValidationError(`${file} uses forbidden capability "${identifier}".`, {
        code: "ALGORITHM_FORBIDDEN_CAPABILITY",
        file,
        identifier
      });
    }
  }

  defaultExportSpan(source, { file });
  return Object.freeze({ ok: true, file, bytes: Buffer.byteLength(source, "utf8") });
}

export function validateAlgorithm(algorithm, { file = "algorithm.js" } = {}) {
  if (!plainRecord(algorithm)) {
    throw new AlgorithmValidationError(`${file} default export must be an object.`, { file });
  }
  if (typeof algorithm.name !== "string" || algorithm.name.trim() === "") {
    throw new AlgorithmValidationError(`${file} is missing a non-empty name.`, { file });
  }
  if (typeof algorithm.signal !== "function") {
    throw new AlgorithmValidationError(`${file} is missing a signal() function.`, { file });
  }
  if (algorithm.init !== undefined && typeof algorithm.init !== "function") {
    throw new AlgorithmValidationError(`${file} init must be a function when provided.`, { file });
  }
  if (algorithm.params !== undefined && !plainRecord(algorithm.params)) {
    throw new AlgorithmValidationError(`${file} params must be a plain object when provided.`, { file });
  }
  return algorithm;
}
