import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";

async function temporaryRepositories() {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-db-research-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  await migrate(client);
  return { client, directory, repositories: createRepositories(client) };
}

test("research plans, provenance, runs, and immutable snapshots persist deterministically", async () => {
  const temporary = await temporaryRepositories();
  const research = temporary.repositories.research;

  try {
    const manifestOne = {
      steps: [
        { type: "web_page", url: "https://example.test/aapl" },
        { type: "ai_summary", model: "local-test" }
      ]
    };
    const firstImport = await research.importPlan({
      planId: "plan-1",
      name: "AAPL research",
      description: "Deterministic research test",
      sourceHash: "plan-hash-1",
      manifest: manifestOne,
      versionId: "plan-version-1",
      at: 10
    });
    const repeatedImport = await research.importPlan({
      planId: "plan-1",
      name: "AAPL research",
      description: "Deterministic research test",
      sourceHash: "plan-hash-1",
      manifest: manifestOne,
      versionId: "ignored-version-id",
      at: 11
    });
    assert.equal(repeatedImport.version.id, firstImport.version.id);
    assert.deepEqual((await research.getPlanVersion("plan-version-1")).manifestJson, manifestOne);

    await assert.rejects(
      research.importPlan({
        planId: "plan-1",
        name: "AAPL research",
        description: "Deterministic research test",
        sourceHash: "plan-hash-1",
        manifest: { steps: [] },
        versionId: "conflicting-version",
        at: 12
      }),
      (error) => error?.code === "ERR_RESEARCH_PLAN_VERSION_CONFLICT"
    );
    await assert.rejects(
      research.importPlan({
        planId: "plan-1",
        name: "Renamed research",
        description: "Deterministic research test",
        sourceHash: "plan-hash-2",
        manifest: { steps: [] },
        versionId: "plan-version-2",
        at: 13
      }),
      (error) => error?.code === "ERR_RESEARCH_PLAN_CONFLICT"
    );

    const secondImport = await research.importPlan({
      planId: "plan-1",
      name: "AAPL research",
      description: "Deterministic research test",
      sourceHash: "plan-hash-2",
      manifest: { steps: [{ type: "ai_summary", model: "local-test-v2" }] },
      versionId: "plan-version-2",
      at: 20
    });
    assert.equal((await research.latestPlanVersion("plan-1")).id, secondImport.version.id);
    assert.equal((await research.listPlans())[0].id, "plan-1");
    assert.equal((await research.getPlan("plan-1")).createdAt, 10);

    const request = { reason: "schedule", requestedAt: 30 };
    const run = await research.createRun({
      id: "run-1",
      planVersionId: "plan-version-2",
      symbol: "aapl",
      request,
      createdAt: 30
    });
    assert.equal(run.symbol, "AAPL");
    assert.deepEqual(run.requestJson, request);
    assert.equal((await research.createRun({
      id: "run-1",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      request,
      createdAt: 31
    })).id, "run-1");
    await assert.rejects(
      research.createRun({
        id: "run-1",
        planVersionId: "plan-version-2",
        symbol: "AAPL",
        request: { reason: "manual" },
        createdAt: 31
      }),
      (error) => error?.code === "ERR_RESEARCH_RUN_CONFLICT"
    );

    const snapshotOne = {
      id: "snapshot-1",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      availableAt: 40,
      summaryText: "AAPL demand remains strong",
      snapshotJson: {
        summary: { headline: "Demand remains strong", confidence: 0.82 },
        sources: [{ documentId: "document-1" }]
      },
      contentHash: "snapshot-hash-1",
      provenance: { adapter: "web_page", model: "local-test" },
      createdAt: 39
    };
    await assert.rejects(
      research.publishSnapshot({ runId: "run-1", completedAt: 41, result: { documents: 1 }, snapshot: snapshotOne }),
      (error) => error?.code === "ERR_RESEARCH_RUN_STATE"
    );
    assert.equal(await research.getSnapshot("snapshot-1"), null);

    assert.equal((await research.startRun("run-1", { at: 32 })).status, "running");
    const document = await research.addDocument({
      id: "document-1",
      runId: "run-1",
      provider: "web_page",
      sourceUrl: "https://example.test/aapl",
      canonicalUrl: "https://example.test/aapl",
      title: "AAPL demand",
      publishedAt: 25,
      retrievedAt: 33,
      contentHash: "document-hash-1",
      contentText: "Demand remains strong.",
      metadata: { status: 200 },
      createdAt: 34
    });
    const duplicateDocument = await research.addDocument({
      id: "document-2",
      runId: "run-1",
      provider: "second_source",
      sourceUrl: "https://second.example.test/aapl",
      retrievedAt: 35,
      contentHash: "document-hash-1",
      contentText: "Demand remains strong.",
      metadata: { status: 200 }
    });
    assert.notEqual(duplicateDocument.id, document.id);
    assert.equal((await research.listDocuments("run-1")).length, 2);
    assert.deepEqual((await research.listDocuments("run-1"))[0].metadataJson, { status: 200 });

    const publicationInput = {
      runId: "run-1",
      completedAt: 41,
      result: { documents: 1 },
      snapshot: snapshotOne
    };
    const publication = await research.publishSnapshot(publicationInput);
    assert.equal(publication.run.status, "completed");
    assert.deepEqual(publication.run.resultJson, { documents: 1 });
    assert.deepEqual(publication.snapshot.snapshotJson, snapshotOne.snapshotJson);
    assert.deepEqual(publication.snapshot.provenanceJson, snapshotOne.provenance);
    assert.equal(publication.snapshot.eligible, true);
    assert.equal((await research.publishSnapshot(publicationInput)).snapshot.id, "snapshot-1");
    assert.equal((await research.getSnapshotByRun("run-1")).id, "snapshot-1");

    await assert.rejects(
      research.publishSnapshot({
        ...publicationInput,
        snapshot: { ...snapshotOne, snapshotJson: { summary: { headline: "Mutated" } } }
      }),
      (error) => error?.code === "ERR_RESEARCH_SNAPSHOT_CONFLICT"
    );
    assert.equal(await research.latestEligibleSnapshot({
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      availableAt: 39
    }), null);
    assert.equal((await research.latestEligibleSnapshot({
      planVersionId: "plan-version-2",
      symbol: "aapl",
      availableAt: 40
    })).id, "snapshot-1");

    await research.createRun({
      id: "run-2",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      createdAt: 50
    });
    await research.startRun("run-2", { at: 51 });
    await research.publishSnapshot({
      runId: "run-2",
      completedAt: 81,
      snapshot: {
        id: "snapshot-2",
        availableAt: 80,
        contentHash: "snapshot-hash-2",
        snapshotJson: { summary: { headline: "Newer research" } },
        createdAt: 79
      }
    });
    await research.createRun({
      id: "run-3",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      createdAt: 60
    });
    await research.startRun("run-3", { at: 61 });
    await research.publishSnapshot({
      runId: "run-3",
      completedAt: 86,
      snapshot: {
        id: "snapshot-ineligible",
        availableAt: 85,
        contentHash: "snapshot-hash-ineligible",
        snapshotJson: { summary: { headline: "Untrusted research" } },
        eligible: false,
        createdAt: 84
      }
    });
    assert.equal((await research.latestEligibleSnapshot({
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      availableAt: 90
    })).id, "snapshot-2");
    assert.deepEqual(
      (await research.timeline({ planVersionId: "plan-version-2", symbol: "AAPL" })).map((entry) => entry.id),
      ["snapshot-1", "snapshot-2"]
    );
    assert.equal(await research.countTimeline({
      planVersionId: "plan-version-2",
      symbol: "AAPL"
    }), 2);
    assert.deepEqual(
      (await research.timeline({
        planVersionId: "plan-version-2",
        symbol: "AAPL",
        eligible: false,
        afterAvailableAt: 80
      })).map((entry) => entry.id),
      ["snapshot-2", "snapshot-ineligible"]
    );

    await research.createRun({
      id: "run-failed",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      createdAt: 100
    });
    const failed = await research.failRun("run-failed", {
      at: 101,
      errorCode: "ERR_ADAPTER",
      errorDetail: "adapter failed"
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "ERR_ADAPTER");
    assert.equal((await research.listRuns({ status: "failed" }))[0].id, "run-failed");

    await research.createRun({
      id: "run-rollback",
      planVersionId: "plan-version-2",
      symbol: "MSFT",
      createdAt: 120
    });
    await research.startRun("run-rollback", { at: 122 });
    await assert.rejects(
      research.publishSnapshot({
        runId: "run-rollback",
        completedAt: 121,
        snapshot: {
          id: "snapshot-rollback",
          availableAt: 121,
          contentHash: "snapshot-hash-rollback",
          snapshotJson: { summary: { headline: "Must roll back" } },
          createdAt: 121
        }
      })
    );
    assert.equal(await research.getSnapshot("snapshot-rollback"), null);
    assert.equal((await research.getRun("run-rollback")).status, "running");
    await research.createSnapshot({
      id: "snapshot-rollback",
      runId: "run-rollback",
      availableAt: 121,
      contentHash: "snapshot-hash-rollback",
      snapshotJson: { summary: { headline: "Visible only after completion" } },
      createdAt: 121
    });
    assert.equal(await research.latestEligibleSnapshot({
      planVersionId: "plan-version-2",
      symbol: "MSFT",
      availableAt: 121
    }), null);
    assert.equal((await research.completeRun("run-rollback", { at: 123 })).status, "completed");
    assert.equal((await research.latestEligibleSnapshot({
      planVersionId: "plan-version-2",
      symbol: "MSFT",
      availableAt: 123
    })).id, "snapshot-rollback");
    await research.createRun({
      id: "run-interrupted-pending",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      createdAt: 130
    });
    await research.createRun({
      id: "run-interrupted-running",
      planVersionId: "plan-version-2",
      symbol: "AAPL",
      createdAt: 131
    });
    await research.startRun("run-interrupted-running", { at: 132 });
    assert.equal(await research.failInterruptedRuns({ at: 140 }), 2);
    assert.equal((await research.getRun("run-interrupted-pending")).errorCode, "RESEARCH_RESTART_INTERRUPTED");
    assert.equal((await research.getRun("run-interrupted-running")).status, "failed");
    assert.equal(research.updateSnapshot, undefined);
  } finally {
    await temporary.client.close();
    await rm(temporary.directory, { recursive: true, force: true });
  }
});
