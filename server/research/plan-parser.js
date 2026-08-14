import { ResearchPlanV1Schema } from "../../packages/shared/research.js";
import { canonicalHash, canonicalStringify, deepFreeze } from "./canonical.js";

export const MAX_RESEARCH_PLAN_BYTES = 256 * 1024;

function sourceText(source) {
  if (typeof source === "string") return source;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    return Buffer.from(source).toString("utf8");
  }
  throw new TypeError("Research plan source must be a string, Buffer, or Uint8Array");
}

export function parseResearchPlan(source, { maxBytes = MAX_RESEARCH_PLAN_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESEARCH_PLAN_BYTES) {
    throw new RangeError(`maxBytes must be between 1 and ${MAX_RESEARCH_PLAN_BYTES}`);
  }

  const text = sourceText(source);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    const error = new RangeError(`Research plan exceeds the ${maxBytes}-byte limit`);
    error.code = "RESEARCH_PLAN_TOO_LARGE";
    throw error;
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    error.code = "RESEARCH_PLAN_JSON_INVALID";
    throw error;
  }
  const result = ResearchPlanV1Schema.safeParse(value);
  if (!result.success) {
    result.error.code = "RESEARCH_PLAN_INVALID";
    result.error.detail = result.error.flatten();
    throw result.error;
  }
  const plan = result.data;
  const canonicalSource = canonicalStringify(plan);
  const sourceHash = canonicalHash(plan);
  return deepFreeze({ plan, canonicalSource, sourceHash });
}
