import { createHash } from "node:crypto";

function stringifyCanonical(value, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot encode cyclic values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stringifyCanonical(item, ancestors)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON objects must be plain objects");
    }
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalStringify(value) {
  return stringifyCanonical(value, new WeakSet());
}

export function canonicalHash(value) {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

