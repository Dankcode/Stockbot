import { createHash } from "node:crypto";
import {
  ResearchFrameSchema,
  ResearchSnapshotSchema
} from "../../packages/shared/research.js";

const normalizedTimelines = new WeakSet();

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSnapshots(left, right) {
  return compareText(left.symbol, right.symbol) ||
    Number(left.availableAt) - Number(right.availableAt) ||
    compareText(left.id, right.id);
}

export function normalizeResearchTimeline(input = []) {
  if (!Array.isArray(input)) throw new TypeError("researchTimeline must be an array.");
  if (normalizedTimelines.has(input)) return input;
  const snapshots = input.map((snapshot) => ResearchSnapshotSchema.parse(snapshot));
  snapshots.sort(compareSnapshots);
  const normalized = deepFreeze(snapshots);
  normalizedTimelines.add(normalized);
  return normalized;
}

export function selectResearchFrame({ timeline = [], symbol, decisionAt }) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const at = Number(decisionAt);
  if (!normalizedSymbol) throw new TypeError("Research selection requires a symbol.");
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new TypeError("Research selection requires a non-negative epoch-ms decisionAt.");
  }
  const normalized = normalizeResearchTimeline(timeline);
  let selected = null;
  for (const snapshot of normalized) {
    if (snapshot.symbol !== normalizedSymbol || Number(snapshot.availableAt) > at) continue;
    if (snapshot.expiresAt !== null && Number(snapshot.expiresAt) <= at) continue;
    if (!selected || Number(snapshot.availableAt) > Number(selected.availableAt) ||
        (Number(snapshot.availableAt) === Number(selected.availableAt) && snapshot.id > selected.id)) {
      selected = snapshot;
    }
  }
  return deepFreeze(ResearchFrameSchema.parse(selected
    ? { status: "available", symbol: normalizedSymbol, decisionAt: at, snapshot: selected }
    : { status: "unavailable", symbol: normalizedSymbol, decisionAt: at, reason: "no_eligible_snapshot" }));
}

export function researchTimelineHash(timeline = []) {
  const normalized = normalizeResearchTimeline(timeline);
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
