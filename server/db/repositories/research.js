import { isDeepStrictEqual } from "node:util";

import {
  assertClient,
  boundedLimit,
  first,
  hydrateRows,
  requireFields,
  toJson
} from "./_helpers.js";

const VERSION_JSON_FIELDS = ["manifestJson"];
const RUN_JSON_FIELDS = ["requestJson", "resultJson"];
const DOCUMENT_JSON_FIELDS = ["metadataJson"];
const SNAPSHOT_JSON_FIELDS = ["snapshotJson", "provenanceJson"];

function researchError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function atValue(value, fallback = Date.now()) {
  if (value && typeof value === "object") return value.at ?? fallback;
  return value ?? fallback;
}

function normalizeSymbol(value, label = "research") {
  const symbol = String(value ?? "").trim().toUpperCase();
  if (!symbol) throw new TypeError(`${label}.symbol is required.`);
  return symbol;
}

function assertPlanIdentity(plan, input) {
  if (plan.name !== input.name || (plan.description ?? null) !== (input.description ?? null)) {
    throw researchError(
      `Research plan ${input.planId} already exists with different immutable metadata.`,
      "ERR_RESEARCH_PLAN_CONFLICT",
      { planId: input.planId }
    );
  }
}

function assertVersionIdentity(version, input) {
  if (!version || version.planId !== input.planId || version.sourceHash !== input.sourceHash ||
      !isDeepStrictEqual(version.manifestJson, input.manifest)) {
    throw researchError(
      `Research plan version for ${input.planId} and ${input.sourceHash} conflicts with stored data.`,
      "ERR_RESEARCH_PLAN_VERSION_CONFLICT",
      { planId: input.planId, sourceHash: input.sourceHash }
    );
  }
}

function assertRunIdentity(run, input, symbol) {
  const request = input.request ?? input.requestJson ?? {};
  if (!run || run.planVersionId !== input.planVersionId || run.symbol !== symbol ||
      !isDeepStrictEqual(run.requestJson, request)) {
    throw researchError(
      `Research run ${input.id} already exists with different immutable data.`,
      "ERR_RESEARCH_RUN_CONFLICT",
      { runId: input.id }
    );
  }
}

function snapshotPayload(input) {
  if (input.snapshotJson !== undefined) return input.snapshotJson;
  if (input.snapshot !== undefined) return input.snapshot;
  const omitted = new Set([
    "runId", "planVersionId", "sourceHash", "summaryText", "provenance",
    "provenanceJson", "eligible", "createdAt"
  ]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !omitted.has(key)));
}

function normalizedSummaryText(input) {
  if (input.summaryText !== undefined) return String(input.summaryText);
  if (typeof input.summary === "string") return input.summary;
  return String(input.summary?.headline ?? input.summary?.overview ?? "");
}

function normalizeSnapshot(input, run) {
  requireFields(input, ["id", "runId", "availableAt"], "research snapshot");
  const sourceHash = input.sourceHash ?? input.contentHash;
  if (!sourceHash) throw new TypeError("research snapshot.sourceHash is required.");
  return {
    id: input.id,
    runId: input.runId,
    planVersionId: input.planVersionId ?? run.planVersionId,
    symbol: normalizeSymbol(input.symbol ?? run.symbol, "research snapshot"),
    availableAt: input.availableAt,
    summaryText: normalizedSummaryText(input),
    snapshotJson: snapshotPayload(input),
    sourceHash,
    provenanceJson: input.provenance ?? input.provenanceJson ?? {},
    eligible: input.eligible !== false,
    createdAt: input.createdAt ?? input.generatedAt ?? Date.now()
  };
}

function hydrateSnapshot(rows) {
  const snapshot = first(rows, SNAPSHOT_JSON_FIELDS);
  return snapshot ? { ...snapshot, eligible: Boolean(snapshot.eligible) } : null;
}

function assertSnapshotIdentity(snapshot, expected) {
  const scalarFields = [
    "id", "runId", "planVersionId", "symbol", "availableAt", "summaryText", "sourceHash", "eligible"
  ];
  const scalarConflict = scalarFields.find((field) => snapshot?.[field] !== expected[field]);
  const jsonConflict = ["snapshotJson", "provenanceJson"].find(
    (field) => !isDeepStrictEqual(snapshot?.[field], expected[field])
  );
  const conflict = scalarConflict ?? jsonConflict;
  if (conflict) {
    throw researchError(
      `Research snapshot ${expected.id} already exists with different immutable data.`,
      "ERR_RESEARCH_SNAPSHOT_CONFLICT",
      { snapshotId: expected.id, field: conflict }
    );
  }
}

export function createResearchRepository(client) {
  assertClient(client);

  async function insertSnapshot(record) {
    const result = await client.execute(
      `INSERT INTO research_snapshots (
        id, run_id, plan_version_id, symbol, available_at, summary_text,
        snapshot_json, source_hash, provenance_json, eligible, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id) DO NOTHING`,
      [
        record.id,
        record.runId,
        record.planVersionId,
        record.symbol,
        record.availableAt,
        record.summaryText,
        toJson(record.snapshotJson, {}),
        record.sourceHash,
        toJson(record.provenanceJson, {}),
        record.eligible ? 1 : 0,
        record.createdAt
      ]
    );
    const snapshot = hydrateSnapshot(
      await client.query("SELECT * FROM research_snapshots WHERE run_id = ?", [record.runId])
    );
    assertSnapshotIdentity(snapshot, record);
    return { snapshot, inserted: Number(result.changes) > 0 };
  }

  const repository = {
    async importPlan(input) {
      requireFields(input, ["planId", "name", "sourceHash", "manifest", "versionId", "at"], "research plan");
      return client.transaction(async (transaction) => {
        const scoped = createResearchRepository(transaction);
        await transaction.execute(
          `INSERT INTO research_plans (id, name, description, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          [input.planId, input.name, input.description ?? null, input.at]
        );
        const plan = await scoped.getPlan(input.planId);
        assertPlanIdentity(plan, input);
        await transaction.execute(
          `INSERT INTO research_plan_versions
            (id, plan_id, source_hash, manifest_json, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (plan_id, source_hash) DO NOTHING`,
          [input.versionId, input.planId, input.sourceHash, toJson(input.manifest, {}), input.at]
        );
        const [version] = await transaction.query(
          "SELECT * FROM research_plan_versions WHERE plan_id = ? AND source_hash = ?",
          [input.planId, input.sourceHash]
        );
        const hydratedVersion = first([version], VERSION_JSON_FIELDS);
        assertVersionIdentity(hydratedVersion, input);
        return { plan, version: hydratedVersion };
      });
    },

    async listPlans(options = {}) {
      const params = [];
      let before = "";
      if (options.beforeCreatedAt !== undefined) {
        before = "WHERE created_at < ?";
        params.push(options.beforeCreatedAt);
      }
      params.push(boundedLimit(options.limit));
      return hydrateRows(
        await client.query(
          `SELECT * FROM research_plans ${before} ORDER BY created_at DESC, id DESC LIMIT ?`,
          params
        )
      );
    },

    async getPlan(planId) {
      return first(await client.query("SELECT * FROM research_plans WHERE id = ?", [planId]));
    },

    async getPlanVersion(versionId) {
      return first(
        await client.query("SELECT * FROM research_plan_versions WHERE id = ?", [versionId]),
        VERSION_JSON_FIELDS
      );
    },

    async latestPlanVersion(planId) {
      return first(
        await client.query(
          `SELECT * FROM research_plan_versions
           WHERE plan_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
          [planId]
        ),
        VERSION_JSON_FIELDS
      );
    },

    async createRun(input) {
      requireFields(input, ["id", "planVersionId", "symbol"], "research run");
      const symbol = normalizeSymbol(input.symbol, "research run");
      await client.execute(
        `INSERT INTO research_runs (
          id, plan_version_id, symbol, status, request_json, result_json,
          started_at, completed_at, error_code, error_detail, created_at
        ) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, ?)
        ON CONFLICT (id) DO NOTHING`,
        [
          input.id,
          input.planVersionId,
          symbol,
          toJson(input.request ?? input.requestJson, {}),
          input.createdAt ?? Date.now()
        ]
      );
      const run = await repository.getRun(input.id);
      assertRunIdentity(run, input, symbol);
      return run;
    },

    async startRun(id, options = {}) {
      const at = atValue(options);
      const result = await client.execute(
        `UPDATE research_runs SET status = 'running', started_at = ?
         WHERE id = ? AND status = 'pending'`,
        [at, id]
      );
      const run = await repository.getRun(id);
      return result.changes > 0 || run?.status === "running" ? run : null;
    },

    async addDocument(input) {
      requireFields(
        input,
        ["id", "runId", "sourceUrl", "retrievedAt", "contentHash", "contentText"],
        "research document"
      );
      await client.execute(
        `INSERT INTO research_documents (
          id, run_id, provider, source_url, canonical_url, title, published_at,
          retrieved_at, content_hash, content_text, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.runId,
          input.provider ?? "web",
          input.sourceUrl,
          input.canonicalUrl ?? null,
          input.title ?? null,
          input.publishedAt ?? null,
          input.retrievedAt,
          input.contentHash,
          input.contentText,
          toJson(input.metadata ?? input.metadataJson, {}),
          input.createdAt ?? input.retrievedAt
        ]
      );
      return first(
        await client.query("SELECT * FROM research_documents WHERE id = ?", [input.id]),
        DOCUMENT_JSON_FIELDS
      );
    },

    async listDocuments(runId, options = {}) {
      if (!runId) throw new TypeError("research document.runId is required.");
      const clauses = ["run_id = ?"];
      const params = [runId];
      if (options.beforeRetrievedAt !== undefined) {
        clauses.push("retrieved_at < ?");
        params.push(options.beforeRetrievedAt);
      }
      params.push(boundedLimit(options.limit, 100, 5_000));
      return hydrateRows(
        await client.query(
          `SELECT * FROM research_documents WHERE ${clauses.join(" AND ")}
           ORDER BY retrieved_at DESC, id DESC LIMIT ?`,
          params
        ),
        DOCUMENT_JSON_FIELDS
      );
    },

    async completeRun(id, options = {}) {
      const at = atValue(options);
      const resultJson = options && typeof options === "object" ? options.result ?? options.resultJson : null;
      const result = await client.execute(
        `UPDATE research_runs SET
           status = 'completed', completed_at = ?, result_json = ?, error_code = NULL, error_detail = NULL
         WHERE id = ? AND status = 'running'`,
        [at, resultJson == null ? null : toJson(resultJson, {}), id]
      );
      const run = await repository.getRun(id);
      return result.changes > 0 || run?.status === "completed" ? run : null;
    },

    async failRun(id, options = {}) {
      const at = atValue(options);
      const errorCode = options && typeof options === "object" ? options.errorCode ?? null : null;
      const errorDetail = options && typeof options === "object" ? options.errorDetail ?? null : null;
      const result = await client.execute(
        `UPDATE research_runs SET
           status = 'failed', completed_at = ?, error_code = ?, error_detail = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
        [at, errorCode, errorDetail, id]
      );
      const run = await repository.getRun(id);
      return result.changes > 0 || run?.status === "failed" ? run : null;
    },

    async failInterruptedRuns(options = {}) {
      const at = atValue(options);
      const result = await client.execute(
        `UPDATE research_runs SET
           status = 'failed', completed_at = ?, error_code = ?, error_detail = ?
         WHERE status IN ('pending', 'running')`,
        [
          at,
          options.errorCode ?? "RESEARCH_RESTART_INTERRUPTED",
          options.errorDetail ?? "Research run was interrupted by a Stockbot restart."
        ]
      );
      return Number(result.changes ?? 0);
    },

    async getRun(id) {
      return first(await client.query("SELECT * FROM research_runs WHERE id = ?", [id]), RUN_JSON_FIELDS);
    },

    async listRuns(options = {}) {
      const clauses = [];
      const params = [];
      for (const [option, column] of [
        ["planVersionId", "plan_version_id"],
        ["symbol", "symbol"],
        ["status", "status"]
      ]) {
        if (options[option]) {
          clauses.push(`${column} = ?`);
          params.push(option === "symbol" ? normalizeSymbol(options[option], "research run query") : options[option]);
        }
      }
      if (options.beforeCreatedAt !== undefined) {
        clauses.push("created_at < ?");
        params.push(options.beforeCreatedAt);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      params.push(boundedLimit(options.limit));
      return hydrateRows(
        await client.query(
          `SELECT * FROM research_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
          params
        ),
        RUN_JSON_FIELDS
      );
    },

    async createSnapshot(input) {
      requireFields(input, ["id", "runId", "availableAt"], "research snapshot");
      const run = await repository.getRun(input.runId);
      if (!run) throw researchError(`Unknown research run: ${input.runId}`, "ERR_RESEARCH_RUN_NOT_FOUND");
      const record = normalizeSnapshot(input, run);
      if (run.planVersionId !== record.planVersionId || run.symbol !== record.symbol) {
        throw researchError(
          "Research snapshot plan version and symbol must match its run.",
          "ERR_RESEARCH_SNAPSHOT_SCOPE",
          { runId: input.runId }
        );
      }
      return (await insertSnapshot(record)).snapshot;
    },

    async getSnapshot(id) {
      return hydrateSnapshot(await client.query("SELECT * FROM research_snapshots WHERE id = ?", [id]));
    },

    async getSnapshotByRun(runId) {
      return hydrateSnapshot(await client.query("SELECT * FROM research_snapshots WHERE run_id = ?", [runId]));
    },

    async publishSnapshot(input) {
      requireFields(input, ["runId", "completedAt", "snapshot"], "research snapshot publication");
      return client.transaction(async (transaction) => {
        const scoped = createResearchRepository(transaction);
        const run = await scoped.getRun(input.runId);
        if (!run) throw researchError(`Unknown research run: ${input.runId}`, "ERR_RESEARCH_RUN_NOT_FOUND");
        const record = normalizeSnapshot({ ...input.snapshot, runId: input.runId }, run);
        if (run.planVersionId !== record.planVersionId || run.symbol !== record.symbol) {
          throw researchError(
            "Research snapshot plan version and symbol must match its run.",
            "ERR_RESEARCH_SNAPSHOT_SCOPE",
            { runId: input.runId }
          );
        }

        if (run.status === "completed") {
          const snapshot = await scoped.getSnapshotByRun(input.runId);
          assertSnapshotIdentity(snapshot, record);
          if (run.completedAt !== input.completedAt) {
            throw researchError(
              `Research run ${input.runId} was completed by a different publication.`,
              "ERR_RESEARCH_RUN_CONFLICT",
              { runId: input.runId }
            );
          }
          return { run, snapshot };
        }
        if (run.status !== "running") {
          throw researchError(
            `Research run ${input.runId} must be running before publication.`,
            "ERR_RESEARCH_RUN_STATE",
            { runId: input.runId, status: run.status }
          );
        }

        const publication = await scoped.createSnapshot(record);
        const result = await transaction.execute(
          `UPDATE research_runs SET
             status = 'completed', completed_at = ?, result_json = ?, error_code = NULL, error_detail = NULL
           WHERE id = ? AND status = 'running'`,
          [
            input.completedAt,
            input.result == null ? null : toJson(input.result, {}),
            input.runId
          ]
        );
        if (Number(result.changes) === 0) {
          const current = await scoped.getRun(input.runId);
          const snapshot = await scoped.getSnapshotByRun(input.runId);
          assertSnapshotIdentity(snapshot, record);
          if (current?.status !== "completed" || current.completedAt !== input.completedAt) {
            throw researchError(
              `Research run ${input.runId} changed state during publication.`,
              "ERR_RESEARCH_RUN_STATE",
              { runId: input.runId, status: current?.status ?? null }
            );
          }
          return { run: current, snapshot };
        }
        return { run: await scoped.getRun(input.runId), snapshot: publication };
      });
    },

    async latestEligibleSnapshot(input) {
      requireFields(input, ["planVersionId", "symbol", "availableAt"], "eligible snapshot query");
      const snapshot = hydrateSnapshot(
        await client.query(
          `SELECT research_snapshots.* FROM research_snapshots
           JOIN research_runs ON research_runs.id = research_snapshots.run_id
           WHERE research_snapshots.plan_version_id = ?
             AND research_snapshots.symbol = ?
             AND research_snapshots.eligible = 1
             AND research_snapshots.available_at <= ?
             AND research_runs.status = 'completed'
           ORDER BY research_snapshots.available_at DESC,
             research_snapshots.created_at DESC, research_snapshots.id DESC LIMIT 1`,
          [input.planVersionId, normalizeSymbol(input.symbol, "eligible snapshot query"), input.availableAt]
        )
      );
      return snapshot;
    },

    async timeline(options = {}) {
      requireFields(options, ["planVersionId", "symbol"], "research timeline query");
      const clauses = [
        "research_snapshots.plan_version_id = ?",
        "research_snapshots.symbol = ?",
        "research_runs.status = 'completed'"
      ];
      const params = [options.planVersionId, normalizeSymbol(options.symbol, "research timeline query")];
      if (options.eligible !== false) clauses.push("research_snapshots.eligible = 1");
      const after = options.afterAvailableAt ?? options.after;
      const before = options.beforeAvailableAt ?? options.before;
      if (after !== undefined) {
        clauses.push("research_snapshots.available_at >= ?");
        params.push(after);
      }
      if (before !== undefined) {
        clauses.push("research_snapshots.available_at <= ?");
        params.push(before);
      }
      params.push(boundedLimit(options.limit, 100, 5_000));
      return hydrateRows(
        await client.query(
          `SELECT research_snapshots.* FROM research_snapshots
           JOIN research_runs ON research_runs.id = research_snapshots.run_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY research_snapshots.available_at,
             research_snapshots.created_at, research_snapshots.id LIMIT ?`,
          params
        ),
        SNAPSHOT_JSON_FIELDS
      ).map((snapshot) => ({ ...snapshot, eligible: Boolean(snapshot.eligible) }));
    },

    async countTimeline(options = {}) {
      requireFields(options, ["planVersionId", "symbol"], "research timeline count");
      const clauses = [
        "research_snapshots.plan_version_id = ?",
        "research_snapshots.symbol = ?",
        "research_runs.status = 'completed'"
      ];
      const params = [options.planVersionId, normalizeSymbol(options.symbol, "research timeline count")];
      if (options.eligible !== false) clauses.push("research_snapshots.eligible = 1");
      const after = options.afterAvailableAt ?? options.after;
      const before = options.beforeAvailableAt ?? options.before;
      if (after !== undefined) {
        clauses.push("research_snapshots.available_at >= ?");
        params.push(after);
      }
      if (before !== undefined) {
        clauses.push("research_snapshots.available_at <= ?");
        params.push(before);
      }
      const [row] = await client.query(
        `SELECT COUNT(*) AS count FROM research_snapshots
         JOIN research_runs ON research_runs.id = research_snapshots.run_id
         WHERE ${clauses.join(" AND ")}`,
        params
      );
      return Number(row?.count ?? 0);
    }
  };

  return Object.freeze(repository);
}
