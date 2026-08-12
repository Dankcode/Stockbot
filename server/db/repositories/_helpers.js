export function assertClient(client) {
  if (!client || typeof client.query !== "function" || typeof client.execute !== "function") {
    throw new TypeError("A repository requires a database client.");
  }
  return client;
}

export function requireFields(value, fields, label = "record") {
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const field of fields) {
    if (value[field] === undefined || value[field] === null || value[field] === "") {
      throw new TypeError(`${label}.${field} is required.`);
    }
  }
  return value;
}

export function toJson(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

export function booleanInteger(value) {
  return value ? 1 : 0;
}

export function boundedLimit(value, fallback = 50, maximum = 250) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(1, Math.min(maximum, Math.trunc(number)));
}

function camelCase(key) {
  return key.replace(/_([a-z])/g, (_, character) => character.toUpperCase());
}

export function hydrateRow(row, jsonFields = []) {
  if (!row) {
    return null;
  }
  const hydrated = Object.fromEntries(Object.entries(row).map(([key, value]) => [camelCase(key), value]));
  for (const field of jsonFields) {
    const value = hydrated[field];
    if (typeof value === "string") {
      try {
        hydrated[field] = JSON.parse(value);
      } catch (cause) {
        const error = new Error(`Invalid JSON stored in ${field}.`, { cause });
        error.code = "ERR_REPOSITORY_JSON";
        throw error;
      }
    }
  }
  return hydrated;
}

export function hydrateRows(rows, jsonFields = []) {
  return rows.map((row) => hydrateRow(row, jsonFields));
}

export function first(rows, jsonFields = []) {
  return hydrateRow(rows[0], jsonFields);
}

