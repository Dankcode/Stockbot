import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketResearchSummarySchema,
  ResearchFrameSchema,
  ResearchPlanV1Schema,
  ResearchSnapshotSchema
} from "../../packages/shared/research.js";

const HASH = "a".repeat(64);

function validPlan() {
  return {
    schemaVersion: 1,
    id: "daily-market-research",
    name: "Daily market research",
    description: "Collect a bounded source and summarize it.",
    symbols: ["AAPL"],
    steps: [
      {
        id: "news",
        kind: "scrape",
        adapter: "web.page.v1",
        request: {
          sourceId: "market-news",
          pathTemplate: "/stocks/{symbol}",
          query: { view: "latest" },
          format: "html"
        },
        limits: { timeoutMs: 10_000, maxBytes: 500_000 }
      },
      {
        id: "summary",
        kind: "summarize",
        adapter: "ai.cli.summary.v1",
        dependsOn: ["news"],
        promptTemplate: "market-summary.v1",
        responseSchema: "market-summary.v1",
        limits: { timeoutMs: 30_000, maxInputBytes: 750_000 }
      }
    ],
    outputStep: "summary",
    delivery: { strategy: true, required: false, maxAgeMs: 3_600_000 }
  };
}

function validSnapshot() {
  return {
    id: "snapshot-1",
    runId: "run-1",
    planId: "daily-market-research",
    planVersionId: "plan-version-1",
    schemaVersion: 1,
    symbol: "AAPL",
    asOf: 1_000,
    availableAt: 2_000,
    expiresAt: 4_000,
    summary: {
      overview: "Demand and margins remain the central questions.",
      keyDrivers: ["Services growth"],
      risks: ["Demand softening"],
      opportunities: ["Margin expansion"],
      sentiment: "neutral",
      confidence: 0.7
    },
    sources: [
      {
        stepId: "news",
        sourceId: "market-news",
        url: "https://example.com/stocks/AAPL",
        title: "Apple market update",
        fetchedAt: 1_500,
        publishedAt: 900,
        contentType: "text/html",
        contentHash: HASH
      }
    ],
    sourceBundleHash: HASH,
    aiInputHash: HASH,
    summarizerConfigHash: HASH,
    inputDocuments: [{
      stepId: "news",
      sourceId: "market-news",
      contentHash: HASH,
      sourceBytes: 100,
      includedBytes: 80,
      truncated: true
    }],
    promptHash: HASH,
    model: "research-model-v1",
    contentHash: HASH
  };
}

test("research plans accept only the registered declarative step shapes", () => {
  const plan = validPlan();
  assert.deepEqual(ResearchPlanV1Schema.parse(plan), plan);
  assert.equal(ResearchPlanV1Schema.safeParse({ ...plan, symbols: ["aapl"] }).success, false);
  assert.equal(ResearchPlanV1Schema.safeParse({ ...plan, symbols: ["*", "AAPL"] }).success, false);
  assert.equal(
    ResearchPlanV1Schema.safeParse({
      ...plan,
      steps: [{ ...plan.steps[0], adapter: "arbitrary.module" }, plan.steps[1]]
    }).success,
    false
  );
  assert.equal(
    ResearchPlanV1Schema.safeParse({ ...plan, delivery: { ...plan.delivery, maxAgeMs: 0 } }).success,
    true
  );
});

test("research plans reject duplicate, forward, unknown, and non-summary outputs", () => {
  const plan = validPlan();
  assert.equal(
    ResearchPlanV1Schema.safeParse({
      ...plan,
      steps: [plan.steps[1], plan.steps[0]]
    }).success,
    false
  );
  assert.equal(
    ResearchPlanV1Schema.safeParse({
      ...plan,
      steps: [plan.steps[0], { ...plan.steps[1], dependsOn: ["missing"] }]
    }).success,
    false
  );
  assert.equal(
    ResearchPlanV1Schema.safeParse({
      ...plan,
      steps: [plan.steps[0], { ...plan.steps[1], id: "news" }]
    }).success,
    false
  );
  assert.equal(ResearchPlanV1Schema.safeParse({ ...plan, outputStep: "news" }).success, false);
});

test("strict plan schemas reject shell and process controls at every step boundary", () => {
  const plan = validPlan();
  for (const unsafePlan of [
    { ...plan, command: "curl example.com" },
    { ...plan, steps: [{ ...plan.steps[0], command: "curl" }, plan.steps[1]] },
    { ...plan, steps: [{ ...plan.steps[0], request: { ...plan.steps[0].request, env: {} } }, plan.steps[1]] },
    { ...plan, steps: [plan.steps[0], { ...plan.steps[1], argv: ["--dangerous"] }] }
  ]) {
    assert.equal(ResearchPlanV1Schema.safeParse(unsafePlan).success, false);
  }
});

test("research plans reject credentials embedded in scrape queries", () => {
  const plan = validPlan();
  plan.steps[0].request.query = { api_key: "must-not-live-in-a-plan" };
  assert.equal(ResearchPlanV1Schema.safeParse(plan).success, false);
});

test("research plans accept only the symbol template variable", () => {
  const plan = validPlan();
  plan.steps[0].request.pathTemplate = "/news/{{account}}";
  assert.equal(ResearchPlanV1Schema.safeParse(plan).success, false);
  plan.steps[0].request.pathTemplate = "/news/{{symbol}}";
  plan.steps[0].request.query = { view: "{{unknown}}" };
  assert.equal(ResearchPlanV1Schema.safeParse(plan).success, false);
});

test("market summaries bound text, arrays, and confidence", () => {
  const summary = validSnapshot().summary;
  assert.deepEqual(MarketResearchSummarySchema.parse(summary), summary);
  assert.equal(MarketResearchSummarySchema.safeParse({ ...summary, confidence: 1.1 }).success, false);
  assert.equal(
    MarketResearchSummarySchema.safeParse({ ...summary, risks: Array.from({ length: 21 }, () => "risk") })
      .success,
    false
  );
  assert.equal(MarketResearchSummarySchema.safeParse({ ...summary, extra: true }).success, false);
});

test("research snapshots enforce chronology, provenance, and deep immutability", () => {
  const snapshot = ResearchSnapshotSchema.parse(validSnapshot());
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.summary), true);
  assert.equal(Object.isFrozen(snapshot.summary.keyDrivers), true);
  assert.equal(Object.isFrozen(snapshot.sources), true);
  assert.equal(Object.isFrozen(snapshot.sources[0]), true);
  assert.equal(Object.isFrozen(snapshot.inputDocuments), true);
  assert.equal(Object.isFrozen(snapshot.inputDocuments[0]), true);

  assert.equal(
    ResearchSnapshotSchema.safeParse({ ...validSnapshot(), availableAt: 999 }).success,
    false
  );
  assert.equal(
    ResearchSnapshotSchema.safeParse({ ...validSnapshot(), expiresAt: 2_000 }).success,
    false
  );
  assert.equal(
    ResearchSnapshotSchema.safeParse({
      ...validSnapshot(),
      sources: [{ ...validSnapshot().sources[0], publishedAt: 1_501 }]
    }).success,
    false
  );
  assert.equal(
    ResearchSnapshotSchema.safeParse({
      ...validSnapshot(),
      inputDocuments: [{ ...validSnapshot().inputDocuments[0], includedBytes: 101 }]
    }).success,
    false
  );
});

test("research frames distinguish eligible snapshots from explicit unavailability", () => {
  const available = ResearchFrameSchema.parse({
    status: "available",
    symbol: "AAPL",
    decisionAt: 3_000,
    snapshot: validSnapshot()
  });
  assert.equal(Object.isFrozen(available), true);
  assert.equal(Object.isFrozen(available.snapshot), true);

  assert.equal(
    ResearchFrameSchema.safeParse({ ...available, symbol: "MSFT" }).success,
    false
  );
  assert.equal(
    ResearchFrameSchema.safeParse({ ...available, decisionAt: 1_999 }).success,
    false
  );
  assert.equal(
    ResearchFrameSchema.safeParse({ ...available, decisionAt: 4_000 }).success,
    false
  );

  const unavailable = ResearchFrameSchema.parse({
    status: "unavailable",
    symbol: "AAPL",
    decisionAt: 3_000,
    reason: "no_eligible_snapshot"
  });
  assert.equal(Object.isFrozen(unavailable), true);
  assert.equal(unavailable.status, "unavailable");
});
