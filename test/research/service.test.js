import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createResearchAdapterRegistry } from "../../server/research/adapters/registry.js";
import { createResearchService } from "../../server/research/service.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function planSource(symbols = ["AAPL"]) {
  return JSON.stringify({
    schemaVersion: 1,
    id: "daily-market-brief",
    name: "Daily market brief",
    symbols,
    steps: [
      {
        id: "news",
        kind: "scrape",
        adapter: "web.page.v1",
        request: {
          sourceId: "market-news",
          pathTemplate: "/stocks/{{symbol}}/news",
          format: "html"
        },
        limits: { timeoutMs: 1_000, maxBytes: 100_000 }
      },
      {
        id: "brief",
        kind: "summarize",
        adapter: "ai.cli.summary.v1",
        dependsOn: ["news"],
        promptTemplate: "market-summary.v1",
        responseSchema: "market-summary.v1",
        limits: { timeoutMs: 1_000, maxInputBytes: 100_000 }
      }
    ],
    outputStep: "brief",
    delivery: { strategy: true, required: true, maxAgeMs: 1_000 }
  });
}

function fakeAdapters() {
  return createResearchAdapterRegistry([
    {
      id: "web.page.v1",
      kind: "scrape",
      version: "test",
      available: true,
      async execute({ step, symbol }) {
        return {
          kind: "documents",
          documents: [{
            stepId: step.id,
            sourceId: step.request.sourceId,
            requestedUrl: `https://news.example/stocks/${symbol}/news`,
            finalUrl: `https://news.example/stocks/${symbol}/news`,
            title: `${symbol} update`,
            fetchedAt: 900,
            publishedAt: 850,
            contentType: "text/html",
            contentHash: HASH_A,
            text: `${symbol} revenue increased.`,
            byteCount: 28
          }]
        };
      }
    },
    {
      id: "ai.cli.summary.v1",
      kind: "summarize",
      version: "test",
      available: true,
      async execute({ symbol }) {
        return {
          kind: "summary",
          summary: {
            overview: `${symbol} revenue increased.`,
            keyDrivers: ["Revenue growth"],
            risks: ["Market volatility"],
            opportunities: ["Demand growth"],
            sentiment: "bullish",
            confidence: 0.8
          },
          model: "fixture-model",
          promptHash: HASH_B,
          aiInputHash: "c".repeat(64),
          summarizerConfigHash: "d".repeat(64),
          inputDocuments: [{
            stepId: "news",
            sourceId: "market-news",
            contentHash: HASH_A,
            sourceBytes: 23,
            includedBytes: 23,
            truncated: false
          }]
        };
      }
    }
  ]);
}

test("research service imports, executes, persists, and selects immutable point-in-time summaries", async (t) => {
  const client = await createClient("file::memory:");
  t.after(() => client.close());
  await migrate(client);
  const repositories = createRepositories(client);
  let now = 1_000;
  let sequence = 0;
  const service = createResearchService({
    repository: repositories.research,
    registry: fakeAdapters(),
    clock: () => now++,
    idFactory: () => `research-${++sequence}`
  });

  const source = planSource();
  const validated = service.validatePlan(source);
  assert.equal(validated.plan.id, "daily-market-brief");
  assert.equal(Object.isFrozen(validated.plan), true);

  const imported = await service.importPlan({ source, filename: "daily.json" });
  const duplicate = await service.importPlan({ source, filename: "daily-copy.json" });
  assert.equal(duplicate.version.id, imported.version.id);

  let releaseLimitedRun;
  const limited = createResearchService({
    repository: repositories.research,
    registry: fakeAdapters(),
    maxConcurrentRuns: 1,
    runner: {
      run() {
        return new Promise((resolve) => { releaseLimitedRun = resolve; });
      }
    }
  });
  const firstLimitedRun = limited.run({ planId: imported.plan.id, symbol: "AAPL" });
  while (!releaseLimitedRun) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    limited.run({ planId: imported.plan.id, symbol: "AAPL" }),
    (error) => error.code === "RESEARCH_RUN_CAPACITY"
  );
  releaseLimitedRun({ ok: true });
  await firstLimitedRun;

  const completed = await service.run({ planId: imported.plan.id, symbol: "aapl" });
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.snapshot.symbol, "AAPL");
  assert.equal(completed.snapshot.summary.sentiment, "bullish");
  assert.equal(Object.isFrozen(completed.snapshot.summary), true);

  const detail = await service.getRun(completed.run.id);
  assert.equal(detail.documents.length, 1);
  assert.equal(detail.snapshot.contentHash, completed.snapshot.contentHash);
  const snapshotDetail = await service.getSnapshot(completed.snapshot.id);
  assert.equal(snapshotDetail.snapshot.contentHash, completed.snapshot.contentHash);
  await assert.rejects(
    service.getSnapshot("missing-snapshot"),
    (error) => error.code === "RESEARCH_SNAPSHOT_NOT_FOUND"
  );

  assert.equal((await service.frameFor({
    planVersionId: imported.version.id,
    symbol: "AAPL",
    decisionAt: completed.snapshot.availableAt - 1
  })).status, "unavailable");
  const available = await service.frameFor({
    planVersionId: imported.version.id,
    symbol: "AAPL",
    decisionAt: completed.snapshot.availableAt
  });
  assert.equal(available.status, "available");
  assert.equal(available.snapshot.id, completed.snapshot.id);
  assert.equal((await service.frameFor({
    planVersionId: imported.version.id,
    symbol: "AAPL",
    decisionAt: completed.snapshot.expiresAt
  })).status, "unavailable");

  const timeline = await service.timelineFor({
    planVersionId: imported.version.id,
    symbol: "AAPL",
    before: completed.snapshot.availableAt
  });
  assert.deepEqual(timeline.map((snapshot) => snapshot.id), [completed.snapshot.id]);

  await assert.rejects(
    service.run({ planId: imported.plan.id, symbol: "MSFT" }),
    (error) => error.code === "RESEARCH_SYMBOL_NOT_ALLOWED"
  );
  await assert.rejects(
    service.run({ planId: "different-plan", planVersionId: imported.version.id, symbol: "AAPL" }),
    (error) => error.code === "RESEARCH_PLAN_VERSION_MISMATCH"
  );
});
