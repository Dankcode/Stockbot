import crypto from "node:crypto";
import { AppError } from "../http/errors.js";
import { summarizeExperiment } from "./report.js";

const PLAN_KIND = "stockbot.experiment.v1";

function invalid(message, detail) {
  return new AppError("EXPERIMENT_PLAN_INVALID", message, 422, detail);
}

function normalizePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.kind !== PLAN_KIND) {
    throw invalid(`Experiment plan must have kind "${PLAN_KIND}".`);
  }
  if (!/^[A-Z0-9][A-Z0-9./-]{0,31}$/.test(String(value.symbol ?? ""))) {
    throw invalid("Experiment plan has an invalid symbol.");
  }
  if (!Array.isArray(value.arms) || value.arms.length === 0 || !Array.isArray(value.groups) || value.groups.length === 0) {
    throw invalid("Experiment plan must contain at least one arm and one strategy group.");
  }
  const arms = new Map();
  for (const arm of value.arms) {
    if (!arm || typeof arm !== "object" || typeof arm.key !== "string" || typeof arm.id !== "string" ||
        typeof arm.algorithmId !== "string" || !["strategy", "control"].includes(arm.kind)) {
      throw invalid("Experiment plan contains an invalid arm.");
    }
    if (arms.has(arm.key) || [...arms.values()].some((known) => known.id === arm.id)) {
      throw invalid("Experiment plan arm keys and labels must be unique.");
    }
    arms.set(arm.key, arm);
  }
  for (const group of value.groups) {
    if (!arms.has(group?.strategy?.key) || arms.get(group.strategy.key).kind !== "strategy" || !Array.isArray(group.controls)) {
      throw invalid("Experiment plan contains an invalid strategy group.");
    }
    for (const control of group.controls) {
      if (!arms.has(control?.key) || arms.get(control.key).kind !== "control") {
        throw invalid("Experiment plan groups may reference only declared control arms.");
      }
    }
  }
  return value;
}

function defaultFillModel(plan, input) {
  return Object.freeze({
    slippageBps: 5,
    fixedCommission: 0,
    perShareCommission: 0,
    ...(plan.fillModel ?? {}),
    ...(input.fillModel ?? {})
  });
}

function reportEntry(session, metrics) {
  return Object.freeze({
    arm: session,
    metrics: metrics
      ? {
          returnPercent: metrics.returnPercent,
          finalEquity: metrics.finalEquity,
          maxDrawdown: metrics.maxDrawdown,
          sharpe: metrics.sharpe,
          sortino: metrics.sortino,
          profitFactor: metrics.profitFactor,
          winRate: metrics.winRate,
          tradeCount: metrics.tradeCount,
          closedTradeCount: metrics.tradeCount,
          exposurePercent: metrics.exposurePercent,
          avgTradePercent: metrics.avgTradePercent,
          openPosition: false
        }
      : null,
    result: null,
    error: metrics ? null : `${session.status}: no metrics recorded`
  });
}

/**
 * Coordinates a durable cohort while deliberately delegating execution to the existing
 * supervisor. Each sibling still owns exactly one algorithm version and ledger.
 */
export function createExperimentService({ repositories, algorithms, supervisor, accountId, idFactory = crypto.randomUUID, clock = Date.now }) {
  if (!repositories?.experiments || !repositories?.sessions || !repositories?.algorithms || !algorithms || !supervisor) {
    throw new TypeError("Experiment service requires experiment/session repositories, algorithms and supervisor.");
  }

  async function resolveVersions(plan) {
    const bindings = {};
    for (const arm of plan.arms) {
      const algorithm = await algorithms.get(arm.algorithmId);
      if (!algorithm.enabled) throw new AppError("ALGORITHM_DISABLED", `Algorithm "${arm.algorithmId}" is disabled.`, 409);
      if (!algorithm.version?.id) throw new AppError("ALGORITHM_VERSION_NOT_FOUND", `No version is registered for ${arm.algorithmId}.`, 404);
      bindings[arm.key] = algorithm.version.id;
    }
    return Object.freeze(bindings);
  }

  async function create(input) {
    const plan = normalizePlan(input?.plan);
    const mode = input?.mode ?? "paper";
    if (mode !== "paper" && mode !== "backtest") throw invalid("Experiment mode must be paper or backtest.");
    const name = String(input?.name ?? "").trim();
    if (!name || name.length > 200) throw invalid("Experiment name must be 1-200 characters.");
    const barInterval = String(input?.barInterval ?? "1day");
    if (!["1min", "5min", "1hour", "1day", "1week", "1month"].includes(barInterval)) {
      throw invalid("Experiment bar interval is not supported.");
    }
    const versions = await resolveVersions(plan);
    const fillModel = defaultFillModel(plan, input);
    const experimentId = input.id ?? idFactory();
    const persistedPlan = Object.freeze({ ...plan, versionBindings: versions });
    const experiment = await repositories.experiments.create({
      id: experimentId,
      name,
      symbol: plan.symbol,
      barInterval,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      fillModel,
      plan: persistedPlan,
      selection: input.selection ?? null,
      createdAt: input.createdAt ?? clock()
    });

    const sessions = [];
    try {
      for (const arm of plan.arms) {
        const session = await supervisor.create({
          accountId: input.accountId ?? accountId,
          name: `${name} · ${arm.id}`,
          mode,
          algorithmVersionId: versions[arm.key],
          symbols: [plan.symbol],
          barInterval,
          params: arm.params ?? {},
          fillModel,
          riskProfile: input.riskProfile ?? {},
          schedule: input.schedule,
          researchPlanId: plan.researchPlanId ?? undefined,
          windowStart: input.windowStart ?? null,
          windowEnd: input.windowEnd ?? null,
          experimentId,
          experimentArm: arm.kind,
          experimentArmId: arm.id
        });
        sessions.push(session);
      }
    } catch (cause) {
      // The schema cascades this cleanup to already-created sibling sessions. A caller
      // never receives a half-cohort and cannot mistake it for an experiment.
      await repositories.experiments.delete(experimentId);
      throw cause;
    }
    return Object.freeze({ experiment, sessions: Object.freeze(sessions) });
  }

  async function get(id) {
    const experiment = await repositories.experiments.getById(id);
    if (!experiment) throw new AppError("EXPERIMENT_NOT_FOUND", `Unknown experiment: ${id}`, 404);
    const sessions = await repositories.sessions.list({ experimentId: id, limit: 1_024 });
    return Object.freeze({ experiment, sessions: Object.freeze(sessions) });
  }

  async function list(options = {}) {
    return repositories.experiments.list(options);
  }

  async function report(id) {
    const { experiment, sessions } = await get(id);
    const plan = normalizePlan(experiment.planJson);
    const byLabel = new Map(sessions.map((session) => [session.experimentArmId, session]));
    const results = new Map();
    await Promise.all(plan.arms.map(async (arm) => {
      const session = byLabel.get(arm.id);
      if (!session) return;
      results.set(arm.key, reportEntry(session, await repositories.sessions.getMetrics(session.id)));
    }));
    return Object.freeze({ experiment, sessions: Object.freeze(sessions), report: summarizeExperiment({ plan, results }) });
  }

  async function start(id) {
    const { experiment, sessions } = await get(id);
    const outcomes = [];
    for (const session of sessions) {
      try {
        outcomes.push(Object.freeze({ session: await supervisor.start(session.id), error: null }));
      } catch (cause) {
        outcomes.push(Object.freeze({ session: await repositories.sessions.getById(session.id), error: cause?.message ?? String(cause), code: cause?.code ?? null }));
      }
    }
    return Object.freeze({ experiment, outcomes: Object.freeze(outcomes) });
  }

  async function halt(id, options = {}) {
    const { experiment, sessions } = await get(id);
    const outcomes = await Promise.all(sessions.map(async (session) => {
      try {
        return Object.freeze({ ...(await supervisor.halt(session.id, options)), error: null });
      } catch (cause) {
        return Object.freeze({ session: await repositories.sessions.getById(session.id), error: cause?.message ?? String(cause), code: cause?.code ?? null });
      }
    }));
    return Object.freeze({ experiment, outcomes: Object.freeze(outcomes) });
  }

  return Object.freeze({ create, get, list, report, start, halt });
}
