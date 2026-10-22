import crypto from "node:crypto";
import {
  AgentCreateSchema,
  AgentPlanSchema,
  ReportSubmissionSchema,
  RetrievalRequestSchema,
  SWARM_CEILINGS
} from "../../packages/shared/swarm.js";
import { createRepositories } from "../db/repositories/index.js";
import { AppError } from "../http/errors.js";
import { canonicalHash } from "../research/canonical.js";
import { generateAgentToken, hashAgentToken, looksLikeAgentToken } from "./tokens.js";

export const GLOBAL_INTENTS_SETTING = "swarm.intents_enabled";
const TASK_LEASE_MS = 30 * 60 * 1_000;
const MAX_BARS_IN_RECEIPT = 120;
const MAX_PAGE_TEXT = 20_000;

function invalid(code, message, detail, status = 422) {
  return new AppError(code, message, status, detail);
}

function parseWith(schema, input, code) {
  const result = schema.safeParse(input);
  if (!result.success) throw invalid(code, "Request validation failed.", result.error.flatten());
  return result.data;
}

/** A provider name says whether the bytes came from a real data vendor; the agent never says so. */
export function isSyntheticProvider(provider, status) {
  return /synthetic|fixture|fake|mock/i.test(String(provider ?? "")) || (status !== undefined && status !== "real");
}

export function createSwarmService({
  client,
  repositories,
  market,
  broker,
  researchAdapters,
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID()
}) {
  const repo = repositories.swarm;

  async function audit(scoped, action, entity, entityId, detail, actor = "operator") {
    await scoped.audit.append({ id: idFactory(), at: clock(), actor, action, entity, entityId, detail });
  }

  async function requireAgent(id) {
    const agent = await repo.getAgent(id);
    if (!agent) throw new AppError("AGENT_NOT_FOUND", `No agent ${id}.`, 404);
    return agent;
  }

  async function createAgent(input, actor = "operator") {
    const parsed = parseWith(AgentCreateSchema, input, "AGENT_INVALID");
    return client.transaction(async (transaction) => {
      const { swarm, accounts, ...scoped } = createRepositories(transaction);
      if (await swarm.getAgentByName(parsed.name)) throw new AppError("AGENT_EXISTS", `Agent ${parsed.name} already exists.`, 409);
      if (await swarm.countAgents() >= SWARM_CEILINGS.maxAgents) {
        throw new AppError("AGENT_CEILING", `The swarm is capped at ${SWARM_CEILINGS.maxAgents} agents.`, 409);
      }
      const at = clock();
      const id = `agent-${parsed.name}`;
      const accountId = `sleeve-${parsed.name}`;
      if (await accounts.getById(accountId)) throw new AppError("AGENT_EXISTS", `Sleeve ${accountId} already exists.`, 409);
      await accounts.create({
        id: accountId,
        name: `Agent sleeve: ${parsed.name}`,
        mode: "paper",
        startingCash: SWARM_CEILINGS.sleeveStartingCashCents,
        createdAt: at
      });
      const agent = await swarm.insertAgent({
        id,
        name: parsed.name,
        description: parsed.description,
        hermesProfile: parsed.hermesProfile ?? `sb-${parsed.name}`,
        accountId,
        createdBy: actor,
        createdAt: at
      });
      await scoped.audit.append({ id: idFactory(), at, actor, action: "agent_created", entity: "agent", entityId: id, detail: { accountId, intentsEnabled: false } });
      return agent;
    });
  }

  async function issueToken(agentId, { rotate = true } = {}) {
    const agent = await requireAgent(agentId);
    if (agent.status === "retired") throw new AppError("AGENT_RETIRED", "A retired agent cannot get a token.", 409);
    const token = generateAgentToken();
    const at = clock();
    await client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      if (rotate) await scoped.swarm.revokeTokens(agentId, at);
      await scoped.swarm.insertToken({ id: idFactory(), agentId, tokenHash: hashAgentToken(token), scopes: ["agent"], createdAt: at });
      await audit(scoped, "agent_token_issued", "agent", agentId, { rotated: rotate });
    });
    return { agentId, token };
  }

  async function revokeTokens(agentId) {
    await requireAgent(agentId);
    const revoked = await repo.revokeTokens(agentId, clock());
    await audit(repositories, "agent_tokens_revoked", "agent", agentId, { revoked });
    return { agentId, revoked };
  }

  /** Resolves a bearer token to its agent, or null. Retired agents and revoked tokens fail. */
  async function authenticate(token) {
    if (!looksLikeAgentToken(token)) return null;
    const row = await repo.findTokenByHash(hashAgentToken(token));
    if (!row || row.revokedAt) return null;
    const agent = await repo.getAgent(row.agentId);
    if (!agent || agent.status === "retired") return null;
    await repo.touchToken(row.id, clock());
    return { agent, tokenId: row.id };
  }

  async function setAgentStatus(agentId, status) {
    if (!["active", "paused", "halted", "retired"].includes(status)) throw invalid("AGENT_STATUS_INVALID", "Unknown status.");
    const current = await requireAgent(agentId);
    // Retirement is final: its sleeve and record stay, but it never trades or gets a token again.
    if (current.status === "retired") throw new AppError("AGENT_RETIRED", "A retired agent cannot change status.", 409);
    const updated = await repo.updateAgent(agentId, { status, at: clock() });
    if (status === "retired") await repo.revokeTokens(agentId, clock());
    await audit(repositories, "agent_status", "agent", agentId, { status });
    return updated;
  }

  async function setAgentIntents(agentId, enabled) {
    await requireAgent(agentId);
    const updated = await repo.updateAgent(agentId, { intentsEnabled: Boolean(enabled), at: clock() });
    await audit(repositories, enabled ? "agent_intents_enabled" : "agent_intents_disabled", "agent", agentId, {});
    return updated;
  }

  async function globalIntentsEnabled() {
    return (await repositories.settings.get(GLOBAL_INTENTS_SETTING))?.value === "true";
  }

  async function setGlobalIntents(enabled) {
    await repositories.settings.set({ key: GLOBAL_INTENTS_SETTING, value: enabled ? "true" : "false", updatedAt: clock() });
    await audit(repositories, enabled ? "swarm_intents_enabled" : "swarm_intents_disabled", "swarm", null, {});
    return { intentsEnabled: Boolean(enabled) };
  }

  function validatePlan(input) {
    const plan = parseWith(AgentPlanSchema, input, "AGENT_PLAN_INVALID");
    return { plan, contentHash: canonicalHash(plan) };
  }

  async function savePlan(agentId, input, { actor = "operator", activate = true } = {}) {
    const agent = await requireAgent(agentId);
    if (agent.status === "retired") throw new AppError("AGENT_RETIRED", "A retired agent cannot get plans.", 409);
    const { plan, contentHash } = validatePlan(input);
    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      const active = await scoped.swarm.getActivePlan(agentId);
      if (active?.contentHash === contentHash) return { plan: active, created: false };
      const at = clock();
      const row = await scoped.swarm.insertPlan({
        id: idFactory(), agentId, version: await scoped.swarm.nextPlanVersion(agentId), contentHash, plan, createdBy: actor, createdAt: at
      });
      if (activate) await scoped.swarm.activatePlan(agentId, row.id, at);
      await audit(scoped, "agent_plan_saved", "agent", agentId, { planId: row.id, version: row.version, activated: activate }, actor);
      return { plan: await scoped.swarm.getPlan(row.id), created: true };
    });
  }

  /** Operator-created task due now: the controlled way to run one cycle on demand. */
  async function createTask(agentId, { dueAt = clock(), expiresInMinutes = 60 } = {}) {
    const agent = await requireAgent(agentId);
    if (agent.status !== "active") throw new AppError("AGENT_NOT_ACTIVE", `Agent is ${agent.status}.`, 409);
    const plan = await repo.getActivePlan(agentId);
    if (!plan) throw new AppError("AGENT_PLAN_MISSING", "Attach a plan before scheduling work.", 409);
    const id = idFactory();
    const created = await repo.insertTask({
      id, agentId, planId: plan.id, kind: "research", slot: `manual:${id}`, dueAt,
      expiresAt: dueAt + Math.max(5, Math.min(720, expiresInMinutes)) * 60_000, createdBy: "operator", createdAt: clock()
    });
    if (!created) throw new AppError("TASK_CONFLICT", "Task already exists.", 409);
    await audit(repositories, "agent_task_created", "agent_task", id, { agentId, dueAt });
    return repo.getTask(id);
  }

  async function requireOwnTask(agent, taskId, { claimed = true } = {}) {
    const task = await repo.getTask(taskId);
    // A foreign task is reported exactly like a missing one, so ids cannot be probed.
    if (!task || task.agentId !== agent.id) throw new AppError("TASK_NOT_FOUND", `No task ${taskId}.`, 404);
    if (claimed) {
      if (task.status !== "claimed") throw new AppError("TASK_NOT_CLAIMED", `Task is ${task.status}.`, 409);
      if (task.leaseExpiresAt <= clock()) throw new AppError("TASK_LEASE_EXPIRED", "The task lease expired.", 409);
    }
    return task;
  }

  async function listAgentTasks(agent, { status } = {}) {
    await repo.expireTasks(clock());
    return repo.listTasks({ agentId: agent.id, status, limit: 50 });
  }

  async function claimTask(agent, taskId) {
    if (agent.status !== "active") throw new AppError("AGENT_NOT_ACTIVE", `Agent is ${agent.status}.`, 409);
    await repo.expireTasks(clock());
    const task = await requireOwnTask(agent, taskId, { claimed: false });
    const claimed = await repo.claimTask({ id: taskId, agentId: agent.id, at: clock(), leaseMs: TASK_LEASE_MS });
    if (!claimed) throw new AppError("TASK_NOT_CLAIMABLE", `Task is ${task.status} or not yet due.`, 409);
    const fresh = await repo.getTask(taskId);
    const plan = await repo.getPlan(fresh.planId);
    return { task: fresh, plan: { id: plan.id, version: plan.version, ...plan.planJson } };
  }

  async function currentTask(agent) {
    const [claimed] = await repo.listTasks({ agentId: agent.id, status: "claimed", limit: 1 });
    if (!claimed) return null;
    const plan = await repo.getPlan(claimed.planId);
    return {
      task: claimed,
      plan: { id: plan.id, version: plan.version, ...plan.planJson },
      receipts: (await repo.listReceiptsForTask(claimed.id)).map(receiptSummary)
    };
  }

  function receiptSummary(receipt) {
    return {
      receiptId: receipt.id,
      kind: receipt.sourceKind,
      request: receipt.requestJson,
      provider: receipt.provider,
      synthetic: receipt.synthetic,
      observedAt: receipt.observedAt,
      fetchedAt: receipt.fetchedAt
    };
  }

  async function performRetrieval(request) {
    if (request.kind === "market.quote") {
      const quote = await market.getQuote(request.symbol, { fresh: true });
      const observedAt = Number(quote.at ?? quote.quoteTime ?? 0) || null;
      return {
        provider: String(quote.source ?? "unknown"),
        synthetic: isSyntheticProvider(quote.source, quote.status),
        observedAt,
        content: {
          symbol: request.symbol, price: quote.price, previousClose: quote.previousClose ?? null,
          changePercent: quote.changePercent ?? null, volume: quote.volume ?? null, status: quote.status ?? null, at: observedAt
        }
      };
    }
    if (request.kind === "market.bars") {
      const data = await market.getBars(request.symbol, request.range);
      const bars = (data.bars ?? []).slice(-MAX_BARS_IN_RECEIPT);
      return {
        provider: String(data.source ?? "unknown"),
        synthetic: isSyntheticProvider(data.source),
        observedAt: Number(bars.at(-1)?.time) || null,
        content: { symbol: request.symbol, range: data.range, interval: data.interval, count: bars.length, bars }
      };
    }
    const adapter = researchAdapters?.resolve("scrape", "web.page.v1");
    if (!adapter?.available) throw new AppError("RESEARCH_SOURCE_NOT_CONFIGURED", "No web sources are registered on this instance.", 503);
    const output = await adapter.execute({
      step: { id: "agent-retrieval", kind: "scrape", adapter: "web.page.v1", request: { sourceId: request.sourceId, pathTemplate: request.path, format: "auto" } },
      symbol: request.symbol ?? "SPY",
      signal: AbortSignal.timeout(30_000)
    });
    const document = output.documents[0];
    return {
      provider: `web:${request.sourceId}`,
      synthetic: false,
      observedAt: document.publishedAt ?? null,
      content: {
        url: document.finalUrl, title: document.title, contentType: document.contentType,
        documentHash: document.contentHash, text: document.text.slice(0, MAX_PAGE_TEXT), truncated: document.text.length > MAX_PAGE_TEXT
      }
    };
  }

  /** Stockbot performs the fetch and writes the receipt; agents only cite receipt ids. */
  function requireActive(agent) {
    if (agent.status !== "active") throw new AppError("AGENT_NOT_ACTIVE", `Agent is ${agent.status}.`, 409);
  }

  async function retrieve(agent, taskId, input) {
    const task = await requireOwnTask(agent, taskId);
    requireActive(await requireAgent(agent.id));
    const request = parseWith(RetrievalRequestSchema, input, "RETRIEVAL_INVALID");
    const plan = (await repo.getPlan(task.planId)).planJson;
    if (!plan.sources.includes(request.kind)) throw invalid("RETRIEVAL_NOT_IN_PLAN", `The plan does not declare ${request.kind}.`);
    if (request.symbol && request.kind !== "web.page" && !plan.universe.symbols.includes(request.symbol)) {
      throw invalid("SYMBOL_NOT_IN_PLAN", `${request.symbol} is outside the plan universe.`);
    }
    const fetched = await performRetrieval(request);
    const receipt = await repo.insertReceipt({
      id: idFactory(),
      agentId: agent.id,
      taskId,
      sourceKind: request.kind,
      request,
      provider: fetched.provider,
      synthetic: fetched.synthetic,
      contentHash: canonicalHash(fetched.content),
      content: fetched.content,
      observedAt: fetched.observedAt,
      fetchedAt: clock()
    });
    return { ...receiptSummary(receipt), contentHash: receipt.contentHash, content: receipt.contentJson };
  }

  async function submitReport(agent, taskId, input) {
    const body = parseWith(ReportSubmissionSchema, input, "REPORT_INVALID");
    return client.transaction(async (transaction) => {
      const scoped = createRepositories(transaction);
      const task = await scoped.swarm.getTask(taskId);
      if (!task || task.agentId !== agent.id) throw new AppError("TASK_NOT_FOUND", `No task ${taskId}.`, 404);
      requireActive(await scoped.swarm.getAgent(agent.id));
      if (task.status !== "claimed") throw new AppError("TASK_NOT_CLAIMED", `Task is ${task.status}.`, 409);
      if (task.leaseExpiresAt <= clock()) throw new AppError("TASK_LEASE_EXPIRED", "The task lease expired.", 409);
      const plan = (await scoped.swarm.getPlan(task.planId)).planJson;
      const receipts = new Map((await scoped.swarm.listReceiptsForTask(taskId)).map((receipt) => [receipt.id, receipt]));
      const cited = new Set();
      for (const decision of body.decisions) {
        if (!plan.universe.symbols.includes(decision.symbol)) {
          throw invalid("SYMBOL_NOT_IN_PLAN", `${decision.symbol} is outside the plan universe.`);
        }
        for (const receiptId of decision.evidence) {
          if (!receipts.has(receiptId)) {
            throw invalid("EVIDENCE_NOT_RECEIPTED", `Evidence ${receiptId} is not a retrieval Stockbot performed for this task.`);
          }
          cited.add(receiptId);
        }
      }
      if (new Set(body.decisions.map((decision) => decision.symbol)).size !== body.decisions.length) {
        throw invalid("REPORT_DUPLICATE_SYMBOL", "Each symbol may have one decision per report.");
      }
      const citedReceipts = [...cited].sort().map((id) => receipts.get(id));
      const provenance = {
        source: "stockbot_receipts",
        receiptCount: citedReceipts.length,
        providers: [...new Set(citedReceipts.map((receipt) => receipt.provider))].sort(),
        kinds: [...new Set(citedReceipts.map((receipt) => receipt.sourceKind))].sort(),
        synthetic: citedReceipts.some((receipt) => receipt.synthetic),
        contentHashes: citedReceipts.map((receipt) => receipt.contentHash)
      };
      const at = clock();
      const reportId = idFactory();
      const report = await scoped.swarm.insertReport({
        id: reportId, agentId: agent.id, taskId, planId: task.planId, summary: body.summary,
        report: body, provenance, contentHash: canonicalHash(body), receiptIds: [...cited].sort(), createdAt: at
      });
      const decisions = [];
      for (const decision of body.decisions) {
        const id = idFactory();
        await scoped.swarm.insertDecision({
          id, agentId: agent.id, reportId, taskId, symbol: decision.symbol, action: decision.action,
          score: decision.score, rationale: decision.rationale, evidence: [...decision.evidence].sort(), createdAt: at
        });
        decisions.push(await scoped.swarm.getDecision(id));
      }
      if (!(await scoped.swarm.completeTask({ id: taskId, reportId, at }))) {
        throw new AppError("TASK_NOT_CLAIMED", "Task changed state while the report was saved.", 409);
      }
      await scoped.audit.append({
        id: idFactory(), at, actor: `agent:${agent.id}`, action: "agent_report_submitted", entity: "agent_report", entityId: reportId,
        detail: { taskId, decisions: decisions.map(({ symbol, action }) => ({ symbol, action })), provenance }
      });
      return { report, decisions, task: await scoped.swarm.getTask(taskId) };
    });
  }

  async function failOwnTask(agent, taskId, { code = "agent_failed", detail } = {}) {
    await requireOwnTask(agent, taskId, { claimed: false });
    const failed = await repo.failTask({ id: taskId, agentId: agent.id, code: String(code).slice(0, 64), detail: detail ? String(detail).slice(0, 2_000) : null, at: clock() });
    if (!failed) throw new AppError("TASK_NOT_OPEN", "Only an open task can be failed.", 409);
    return repo.getTask(taskId);
  }

  async function getOwnTask(agent, taskId) {
    const task = await requireOwnTask(agent, taskId, { claimed: false });
    const report = task.reportId ? await repo.getReport(task.reportId) : null;
    return {
      task,
      report,
      decisions: report ? await repo.listDecisions({ reportId: report.id }) : [],
      receipts: (await repo.listReceiptsForTask(task.id)).map(receiptSummary)
    };
  }

  async function portfolio(agent) {
    return broker.portfolio(agent.accountId);
  }

  async function agentDetail(agentId) {
    const agent = await requireAgent(agentId);
    const [plan, tasks, reports, intents, tokens] = await Promise.all([
      repo.getActivePlan(agentId),
      repo.listTasks({ agentId, limit: 20 }),
      repo.listReports({ agentId, limit: 10 }),
      repo.listIntents({ agentId, limit: 20 }),
      repo.listTokens(agentId)
    ]);
    return {
      agent,
      globalIntentsEnabled: await globalIntentsEnabled(),
      activePlan: plan,
      tasks,
      reports: await Promise.all(reports.map(async (report) => ({ ...report, decisions: await repo.listDecisions({ reportId: report.id }) }))),
      intents,
      tokens
    };
  }

  return Object.freeze({
    createAgent, issueToken, revokeTokens, authenticate, setAgentStatus, setAgentIntents,
    globalIntentsEnabled, setGlobalIntents, validatePlan, savePlan, createTask, listAgentTasks,
    claimTask, currentTask, getOwnTask, retrieve, submitReport, failOwnTask, portfolio, agentDetail,
    listAgents: () => repo.listAgents({ includeRetired: true }),
    requireAgent
  });
}
