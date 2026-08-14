import test from "node:test";
import assert from "node:assert/strict";

import { canonicalHash, canonicalStringify, deepFreeze } from "../../server/research/canonical.js";
import { MAX_RESEARCH_PLAN_BYTES, parseResearchPlan } from "../../server/research/plan-parser.js";

function validPlan() {
  return {
    schemaVersion: 1,
    id: "daily-market-research",
    name: "Daily market research",
    symbols: ["AAPL"],
    steps: [
      {
        id: "page",
        kind: "scrape",
        adapter: "web.page.v1",
        request: {
          sourceId: "market-news",
          pathTemplate: "/stocks/{{symbol}}",
          format: "auto"
        },
        limits: { timeoutMs: 10_000, maxBytes: 500_000 }
      },
      {
        id: "summary",
        kind: "summarize",
        adapter: "ai.cli.summary.v1",
        dependsOn: ["page"],
        promptTemplate: "market-summary.v1",
        responseSchema: "market-summary.v1",
        limits: { timeoutMs: 30_000, maxInputBytes: 500_000 }
      }
    ],
    outputStep: "summary",
    delivery: { strategy: true, required: true, maxAgeMs: 3_600_000 }
  };
}

test("canonical JSON sorts object keys, preserves arrays, and hashes deterministically", () => {
  const left = { zebra: 1, alpha: { second: 2, first: ["b", "a"] } };
  const right = { alpha: { first: ["b", "a"], second: 2 }, zebra: 1 };
  assert.equal(canonicalStringify(left), '{"alpha":{"first":["b","a"],"second":2},"zebra":1}');
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(canonicalHash(left), canonicalHash(right));
  assert.match(canonicalHash(left), /^[a-f0-9]{64}$/);
  assert.throws(() => canonicalStringify({ unsafe: undefined }), TypeError);
});

test("deepFreeze recursively freezes object and array values", () => {
  const value = { nested: [{ id: "one" }] };
  assert.equal(deepFreeze(value), value);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.nested), true);
  assert.equal(Object.isFrozen(value.nested[0]), true);
});

test("plan parser validates, canonicalizes, hashes, and freezes parsed JSON", () => {
  const plan = validPlan();
  const parsed = parseResearchPlan(JSON.stringify(plan, null, 2));
  const reordered = parseResearchPlan(JSON.stringify({
    delivery: plan.delivery,
    outputStep: plan.outputStep,
    steps: plan.steps,
    symbols: plan.symbols,
    name: plan.name,
    id: plan.id,
    schemaVersion: plan.schemaVersion
  }));

  assert.deepEqual(parsed.plan, plan);
  assert.equal(parsed.canonicalSource, canonicalStringify(plan));
  assert.equal(parsed.sourceHash, canonicalHash(plan));
  assert.equal(parsed.sourceHash, reordered.sourceHash);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.plan), true);
  assert.equal(Object.isFrozen(parsed.plan.steps), true);
  assert.equal(Object.isFrozen(parsed.plan.steps[0].request), true);
});

test("plan parser applies a UTF-8 byte limit before parsing", () => {
  assert.throws(
    () => parseResearchPlan(" ".repeat(MAX_RESEARCH_PLAN_BYTES + 1)),
    /byte limit/
  );
  assert.throws(() => parseResearchPlan(JSON.stringify(validPlan()), { maxBytes: 10 }), /byte limit/);
  assert.throws(
    () => parseResearchPlan(JSON.stringify(validPlan()), { maxBytes: MAX_RESEARCH_PLAN_BYTES + 1 }),
    RangeError
  );
});

test("plan parser accepts bytes but rejects invalid JSON and invalid plans", () => {
  const source = JSON.stringify(validPlan());
  assert.equal(parseResearchPlan(Buffer.from(source)).plan.id, "daily-market-research");
  assert.throws(() => parseResearchPlan("{not-json}"), SyntaxError);
  assert.throws(() => parseResearchPlan(JSON.stringify({ ...validPlan(), shell: true })));
  assert.throws(() => parseResearchPlan({ source }), TypeError);
});
