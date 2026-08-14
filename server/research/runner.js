import { randomUUID } from "node:crypto";
import {
  ResearchPlanSchema,
  ResearchSnapshotSchema,
  SymbolOrWildcardSchema
} from "../../packages/shared/research.js";
import { canonicalHash } from "./canonical.js";

const MAX_RESEARCH_RUN_DOCUMENT_BYTES = 20 * 1024 * 1024;

function runnerError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function normalizeSymbol(value) {
  const symbol = String(value ?? "").trim().toUpperCase();
  const parsed = SymbolOrWildcardSchema.safeParse(symbol);
  if (!parsed.success || symbol === "*") {
    throw runnerError("A research run requires one concrete market symbol.", "RESEARCH_SYMBOL_INVALID");
  }
  return symbol;
}

function sourceRecords(documents) {
  return documents.map((document) => Object.freeze({
    stepId: document.stepId,
    sourceId: document.sourceId,
    url: document.finalUrl,
    title: document.title ?? null,
    fetchedAt: document.fetchedAt,
    publishedAt: document.publishedAt ?? null,
    contentType: document.contentType,
    contentHash: document.contentHash
  }));
}

export function createResearchRunner({ repository, registry, clock = Date.now, idFactory = randomUUID } = {}) {
  if (!repository || typeof repository.createRun !== "function") {
    throw new TypeError("Research runner requires a research repository.");
  }
  if (!registry || typeof registry.resolve !== "function") {
    throw new TypeError("Research runner requires an adapter registry.");
  }

  return Object.freeze({
    async run({ planVersion, symbol: requestedSymbol, signal, request = {} }) {
      if (!planVersion?.id || !planVersion?.planId) {
        throw runnerError("Research run requires an immutable plan version.", "RESEARCH_PLAN_VERSION_REQUIRED");
      }
      const plan = ResearchPlanSchema.parse(planVersion.manifestJson ?? planVersion.manifest);
      registry.validatePlan(plan);
      const symbol = normalizeSymbol(requestedSymbol);
      if (!plan.symbols.includes("*") && !plan.symbols.includes(symbol)) {
        throw runnerError(`Research plan ${plan.id} does not allow ${symbol}.`, "RESEARCH_SYMBOL_NOT_ALLOWED", {
          planId: plan.id,
          symbol
        });
      }

      const run = await repository.createRun({
        id: idFactory(),
        planVersionId: planVersion.id,
        symbol,
        request: { ...request, planId: plan.id, planVersionId: planVersion.id },
        createdAt: clock()
      });
      await repository.startRun(run.id, { at: clock() });
      const artifacts = new Map();
      const documents = [];
      let documentBytes = 0;

      try {
        for (const step of plan.steps) {
          if (signal?.aborted) throw runnerError("Research run was canceled.", "RESEARCH_RUN_ABORTED");
          const adapter = registry.resolve(step.kind, step.adapter);
          const inputs = (step.dependsOn ?? []).map((dependency) => artifacts.get(dependency));
          const output = await adapter.execute({ step, symbol, inputs, signal, plan });
          artifacts.set(step.id, output);
          if (output?.kind === "documents") {
            for (const document of output.documents) {
              const bytes = Buffer.byteLength(String(document.text ?? ""), "utf8");
              documentBytes += bytes;
              if (documentBytes > MAX_RESEARCH_RUN_DOCUMENT_BYTES) {
                throw runnerError(
                  "Research run exceeded its cumulative document byte budget.",
                  "RESEARCH_RUN_TOO_LARGE",
                  { maxBytes: MAX_RESEARCH_RUN_DOCUMENT_BYTES }
                );
              }
              documents.push(document);
              await repository.addDocument({
                id: idFactory(),
                runId: run.id,
                provider: step.adapter,
                sourceUrl: document.requestedUrl,
                canonicalUrl: document.finalUrl,
                title: document.title,
                publishedAt: document.publishedAt,
                retrievedAt: document.fetchedAt,
                contentHash: document.contentHash,
                contentText: document.text,
                metadata: {
                  stepId: document.stepId,
                  sourceId: document.sourceId,
                  contentType: document.contentType,
                  byteCount: bytes
                },
                createdAt: document.fetchedAt
              });
            }
          }
        }

        const finalArtifact = artifacts.get(plan.outputStep);
        if (finalArtifact?.kind !== "summary") {
          throw runnerError("Research plan output step did not produce a summary.", "RESEARCH_OUTPUT_MISSING");
        }
        const sources = sourceRecords(documents);
        const sourceBundleHash = canonicalHash(sources.map(({ stepId, sourceId, url, fetchedAt, contentHash }) => ({
          stepId,
          sourceId,
          url,
          fetchedAt,
          contentHash
        })));
        const availableAt = clock();
        const asOf = sources.reduce((latest, source) => Math.max(latest, source.fetchedAt), 0);
        const expiresAt = plan.delivery.maxAgeMs === 0 ? null : availableAt + plan.delivery.maxAgeMs;
        const snapshotCore = {
          id: idFactory(),
          runId: run.id,
          planId: plan.id,
          planVersionId: planVersion.id,
          schemaVersion: 1,
          symbol,
          asOf,
          availableAt,
          expiresAt,
          summary: finalArtifact.summary,
          sources,
          sourceBundleHash,
          aiInputHash: finalArtifact.aiInputHash,
          summarizerConfigHash: finalArtifact.summarizerConfigHash,
          inputDocuments: finalArtifact.inputDocuments,
          promptHash: finalArtifact.promptHash,
          model: finalArtifact.model
        };
        const snapshot = ResearchSnapshotSchema.parse({
          ...snapshotCore,
          contentHash: canonicalHash(snapshotCore)
        });
        const published = typeof repository.publishSnapshot === "function"
          ? await repository.publishSnapshot({
              runId: run.id,
              completedAt: availableAt,
              result: { snapshotId: snapshot.id, contentHash: snapshot.contentHash },
              snapshot: {
                id: snapshot.id,
                runId: run.id,
                planVersionId: planVersion.id,
                symbol,
                availableAt,
                summaryText: snapshot.summary.overview,
                snapshot,
                sourceHash: sourceBundleHash,
                provenance: { sources },
                createdAt: availableAt
              }
            })
          : null;
        if (!published) {
          throw runnerError("Research repository could not atomically publish the summary.", "RESEARCH_PUBLISH_FAILED");
        }
        return Object.freeze({ run: published.run, snapshot, cache: { hit: false } });
      } catch (error) {
        await repository.failRun(run.id, {
          at: clock(),
          errorCode: error?.code ?? "RESEARCH_RUN_FAILED",
          errorDetail: String(error?.message ?? error).slice(0, 2_000)
        }).catch(() => undefined);
        throw error;
      }
    }
  });
}
