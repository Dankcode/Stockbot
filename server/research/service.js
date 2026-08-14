import { randomUUID } from "node:crypto";
import { ResearchPlanSchema } from "../../packages/shared/research.js";
import { parseResearchPlan } from "./plan-parser.js";
import { selectResearchFrame } from "./timeline.js";
import { createResearchRunner } from "./runner.js";

function serviceError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

export function createResearchService({
  repository,
  registry,
  runner,
  clock = Date.now,
  idFactory = randomUUID,
  maxConcurrentRuns = 2
} = {}) {
  if (!repository || typeof repository.importPlan !== "function") {
    throw new TypeError("Research service requires a research repository.");
  }
  if (!registry || typeof registry.validatePlan !== "function") {
    throw new TypeError("Research service requires an adapter registry.");
  }
  if (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 32) {
    throw new TypeError("Research service maxConcurrentRuns must be an integer from 1 through 32.");
  }
  const pipeline = runner ?? createResearchRunner({ repository, registry, clock, idFactory });
  let activeRuns = 0;

  async function resolveVersion({ planId, planVersionId } = {}) {
    const version = planVersionId
      ? await repository.getPlanVersion(planVersionId)
      : planId
        ? await repository.latestPlanVersion(planId)
        : null;
    if (!version) {
      throw serviceError("Research plan version was not found.", "RESEARCH_PLAN_VERSION_NOT_FOUND", {
        planId: planId ?? null,
        planVersionId: planVersionId ?? null
      });
    }
    if (planId && version.planId !== planId) {
      throw serviceError(
        `Research plan version ${version.id} does not belong to ${planId}.`,
        "RESEARCH_PLAN_VERSION_MISMATCH",
        { planId, planVersionId: version.id, actualPlanId: version.planId }
      );
    }
    return version;
  }

  return Object.freeze({
    adapters: registry,

    validatePlan(source) {
      const parsed = parseResearchPlan(source);
      registry.validatePlan(parsed.plan);
      return parsed;
    },

    async importPlan({ source, filename = "research-plan.json" }) {
      const parsed = parseResearchPlan(source, { file: filename });
      registry.validatePlan(parsed.plan);
      const imported = await repository.importPlan({
        planId: parsed.plan.id,
        name: parsed.plan.name,
        description: parsed.plan.description ?? null,
        sourceHash: parsed.sourceHash,
        manifest: parsed.plan,
        versionId: idFactory(),
        at: clock()
      });
      return Object.freeze({ ...imported, plan: parsed.plan, sourceHash: parsed.sourceHash });
    },

    async listPlans(options) {
      const plans = await repository.listPlans(options);
      return Promise.all(plans.map(async (plan) => ({
        ...plan,
        latestVersion: await repository.latestPlanVersion(plan.id)
      })));
    },

    async getPlan(planId) {
      const plan = await repository.getPlan(planId);
      if (!plan) throw serviceError(`Unknown research plan: ${planId}`, "RESEARCH_PLAN_NOT_FOUND");
      return { ...plan, latestVersion: await repository.latestPlanVersion(planId) };
    },

    getPlanVersion(planVersionId) {
      return resolveVersion({ planVersionId });
    },

    latestPlanVersion(planId) {
      return resolveVersion({ planId });
    },

    async run(input) {
      if (activeRuns >= maxConcurrentRuns) {
        throw serviceError(
          "Research execution capacity is full; retry after an active run completes.",
          "RESEARCH_RUN_CAPACITY",
          { maxConcurrentRuns }
        );
      }
      activeRuns += 1;
      try {
        const planVersion = await resolveVersion(input);
        ResearchPlanSchema.parse(planVersion.manifestJson);
        return await pipeline.run({
          planVersion,
          symbol: input.symbol,
          signal: input.signal,
          request: input.request
        });
      } finally {
        activeRuns -= 1;
      }
    },

    async getRun(runId) {
      const run = await repository.getRun(runId);
      if (!run) throw serviceError(`Unknown research run: ${runId}`, "RESEARCH_RUN_NOT_FOUND");
      const [snapshot, documents] = await Promise.all([
        repository.getSnapshotByRun?.(runId) ?? null,
        repository.listDocuments?.(runId) ?? []
      ]);
      return { run, snapshot: snapshot?.snapshotJson ?? null, documents };
    },

    async getSnapshot(snapshotId) {
      const row = await repository.getSnapshot(snapshotId);
      if (!row) {
        throw serviceError(`Unknown research snapshot: ${snapshotId}`, "RESEARCH_SNAPSHOT_NOT_FOUND");
      }
      return {
        id: row.id,
        runId: row.runId,
        planVersionId: row.planVersionId,
        symbol: row.symbol,
        availableAt: row.availableAt,
        eligible: row.eligible,
        createdAt: row.createdAt,
        snapshot: row.snapshotJson,
        provenance: row.provenanceJson
      };
    },

    listRuns(options) {
      return repository.listRuns(options);
    },

    async frameFor({ planVersionId, symbol, decisionAt }) {
      const row = await repository.latestEligibleSnapshot({ planVersionId, symbol, availableAt: decisionAt });
      return selectResearchFrame({ timeline: row ? [row.snapshotJson] : [], symbol, decisionAt });
    },

    async timelineFor({ planVersionId, symbol, after, before, limit }) {
      const rows = await repository.timeline({ planVersionId, symbol, after, before, limit });
      return rows.map((row) => row.snapshotJson);
    }
  });
}
