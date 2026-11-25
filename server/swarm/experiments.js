/**
 * Swarm experiments: several paper arms started on the same day with the same
 * cash, so the way stocks are picked is the only thing that differs between
 * them. LLM arms are ordinary swarm agents whose plan picks SPY + the top N of
 * a Discovery lens; the control arm is mechanical (SPY/QQQ bought once and
 * held) so it measures the market, not an LLM's choices.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { DEFAULT_UNIVERSE_CAP, SWARM_CEILINGS } from "../../packages/shared/swarm.js";
import { AppError } from "../http/errors.js";
import { marketSession } from "../risk/market-hours.js";
import { createRiskEngine } from "../risk/engine.js";
import { DEFAULT_RISK_PROFILE } from "../risk/profile.js";
import { isTradingDate, nextTradingDate, nyDate, nyMinutes } from "./calendar.js";
import { armMetrics, BENCHMARKS } from "./comparison.js";
import { roundTrips } from "./trades.js";

/** The control holds two ~50% positions; the agent sleeve caps (15%) would refuse them. */
export const CONTROL_RISK_PROFILE = Object.freeze({
  ...DEFAULT_RISK_PROFILE,
  id: "swarm-control",
  name: "Swarm index control (buy once, hold)",
  rules: {
    ...DEFAULT_RISK_PROFILE.rules,
    maxPositionSize: { enabled: true, percentOfEquity: 50 },
    maxSymbolExposure: { enabled: true, percentOfEquity: 50 },
    maxConcurrentPositions: { enabled: true, count: 2 }
  }
});
export const CONTROL_LEGS = Object.freeze([{ symbol: "SPY", percent: 49.5 }, { symbol: "QQQ", percent: 49.5 }]);
export const DEFAULT_LENSES = Object.freeze(["growth", "hold"]);
const NAME = /^[a-z][a-z0-9]{1,20}$/;

/** The plan every LLM arm of an experiment shares; only `universe.discovery.score` (and a learned model) differ. */
export function armPlan({ experiment, lens, top, learned = null, template = {} }) {
  return {
    kind: "stockbot.agent-plan.v1",
    name: `${experiment} · ${lens === "learned" ? learned.modelId : lens}`,
    description: `Experiment ${experiment}: SPY plus the top ${top} Discovery picks by the ${lens} score. Paper only.`,
    universe: {
      symbols: ["SPY"],
      discovery: { score: lens, top, ...(learned ? { learned } : {}) },
      totalCap: DEFAULT_UNIVERSE_CAP
    },
    cadence: template.cadence ?? [{ task: "research", schedule: { type: "daily", at: "10:15", timezone: "America/New_York", weekdays: [1, 2, 3, 4, 5] }, expiresAfterMinutes: 120 }],
    sources: template.sources ?? ["market.quote", "market.bars"],
    decision: template.decision ?? { minScore: 7, positionPercent: 10, stopLossPercent: 8, maxHoldDays: 60 }
  };
}

export const ExperimentCreateSchema = z.object({
  name: z.string().trim().regex(NAME, "Use 2-21 lowercase letters or digits, starting with a letter."),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  top: z.number().int().min(1).max(DEFAULT_UNIVERSE_CAP - 1).default(DEFAULT_UNIVERSE_CAP - 1),
  lenses: z.array(z.enum(["growth", "hold"])).min(1).max(2).default([...DEFAULT_LENSES]),
  template: z.object({
    cadence: z.array(z.unknown()).optional(),
    sources: z.array(z.string()).optional(),
    decision: z.record(z.string(), z.unknown()).optional()
  }).strict().default({})
}).strict();

export function createExperimentService({
  repositories,
  swarm,
  broker,
  ledger,
  market,
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID()
}) {
  const repo = repositories.swarmExperiments;
  const controlRisk = createRiskEngine(CONTROL_RISK_PROFILE);

  async function audit(action, entityId, detail, actor = "operator") {
    await repositories.audit.append({ id: idFactory(), at: clock(), actor, action, entity: "swarm_experiment", entityId, detail });
  }

  function defaultStartDate(at) {
    const today = nyDate(at);
    return isTradingDate(today) && nyMinutes(at) < 16 * 60 ? today : nextTradingDate(today);
  }

  async function createExperiment(input, actor = "operator") {
    const parsed = ExperimentCreateSchema.safeParse(input ?? {});
    if (!parsed.success) throw new AppError("EXPERIMENT_INVALID", "Request validation failed.", 422, parsed.error.flatten());
    const { name, top, lenses, template } = parsed.data;
    if (await repo.getExperimentByName(name)) throw new AppError("EXPERIMENT_EXISTS", `Experiment ${name} already exists.`, 409);
    const startDate = parsed.data.startDate ?? defaultStartDate(clock());
    if (!isTradingDate(startDate)) throw new AppError("EXPERIMENT_INVALID", `${startDate} is not a trading day.`, 422);
    const agentNames = lenses.map((lens) => `${name}-${lens}`);
    for (const agentName of agentNames) {
      if (await repositories.swarm.getAgentByName(agentName)) throw new AppError("AGENT_EXISTS", `Agent ${agentName} already exists.`, 409);
    }
    if (await repositories.swarm.countAgents() + lenses.length > SWARM_CEILINGS.maxAgents) {
      throw new AppError("AGENT_CEILING", `The swarm is capped at ${SWARM_CEILINGS.maxAgents} agents.`, 409);
    }
    const plans = lenses.map((lens) => armPlan({ experiment: name, lens, top, template }));
    for (const plan of plans) swarm.validatePlan(plan);

    const at = clock();
    const experiment = await repo.insertExperiment({ id: idFactory(), name, startDate, config: { top, lenses, template, cap: DEFAULT_UNIVERSE_CAP }, createdAt: at });
    const arms = [];
    for (const [index, lens] of lenses.entries()) {
      const agent = await swarm.createAgent({ name: agentNames[index], description: `Experiment ${name}: ${lens} lens` }, actor);
      await swarm.savePlan(agent.id, plans[index], { actor });
      arms.push(await repo.insertArm({
        id: idFactory(), experimentId: experiment.id, label: `disc-${lens}`, kind: "agent", agentId: agent.id, accountId: agent.accountId,
        startDate, config: { lens, top }, createdBy: "operator", createdAt: at
      }));
    }
    const controlAccount = `control-${name}`;
    await repositories.accounts.create({ id: controlAccount, name: `Index control: ${name}`, mode: "paper", startingCash: SWARM_CEILINGS.sleeveStartingCashCents, createdAt: at });
    arms.push(await repo.insertArm({
      id: idFactory(), experimentId: experiment.id, label: "control-index", kind: "control", accountId: controlAccount,
      startDate, config: { legs: CONTROL_LEGS }, createdBy: "operator", createdAt: at
    }));
    await audit("swarm_experiment_created", experiment.id, { name, startDate, arms: arms.map((arm) => arm.label) }, actor);
    return { experiment, arms, agents: agentNames };
  }

  /** Buys each missing control leg once, during the session, from the arm's start date. Never sells. */
  async function ensureControl(arm, at = clock()) {
    if (arm.kind !== "control" || arm.status !== "active") return [];
    const today = nyDate(at);
    if (today < arm.startDate || !marketSession("SPY", at).open) return [];
    const bought = new Set((await repo.accountFills(arm.accountId)).filter((fill) => fill.side === "buy").map((fill) => fill.symbol));
    const account = await repositories.accounts.getById(arm.accountId);
    const results = [];
    for (const leg of arm.configJson.legs ?? CONTROL_LEGS) {
      if (bought.has(leg.symbol)) continue;
      try {
        const quote = await market.getQuote(leg.symbol, { fresh: true });
        const price = Number(quote?.price);
        if (quote?.status !== "real" || !(price > 0)) { results.push({ symbol: leg.symbol, status: "skipped", reason: "no real quote" }); continue; }
        const notionalCents = Number(account.startingCash) * (leg.percent / 100);
        const qty = Math.floor((notionalCents / 100 / price) * 1_000_000);
        const execution = await broker.submitOrder({
          clientOrderId: `control:${arm.id}:${leg.symbol}:${today}`,
          accountId: arm.accountId, symbol: leg.symbol, side: "buy", qty, quote, riskEngine: controlRisk,
          signalReason: `control:${arm.label} buy-and-hold ${leg.percent}%`
        });
        results.push({ symbol: leg.symbol, status: execution.order.status, reason: execution.order.rejectReason ?? null });
      } catch (error) {
        results.push({ symbol: leg.symbol, status: "error", reason: error.message });
      }
    }
    return results;
  }

  /** A retired arm's sleeve is sold to cash during the next session; its history stays. */
  async function liquidateRetired(arm, at = clock()) {
    if (arm.status !== "retired" || !marketSession("SPY", at).open) return null;
    const open = await ledger.listOpenPositions(arm.accountId);
    if (!open.length) return null;
    return broker.liquidate(arm.accountId, { operationId: `retire-${arm.id}-${nyDate(at)}`, reason: `Arm ${arm.label} retired: ${arm.retireReason ?? "review"}` });
  }

  /** Records the arm's equity for a trading date. Returns false when a real mark was unavailable. */
  async function snapshot(arm, date, at = clock()) {
    const portfolio = await broker.portfolio(arm.accountId, { fresh: true, rememberQuotes: false });
    if (portfolio.equity === null || portfolio.equity === undefined) return false;
    await repo.putSnapshot({
      armId: arm.id, date, equity: Number(portfolio.equity), cash: Number(portfolio.cash),
      positions: portfolio.positions.map(({ symbol, qty, price, marketValue }) => ({ symbol, qty, price, marketValue })), takenAt: at
    });
    return true;
  }

  /** Stores SPY and QQQ daily closes (bars, keyed by their UTC date) up to `date`. */
  async function recordBenchmarks(date, at = clock()) {
    const stored = {};
    for (const symbol of BENCHMARKS) {
      const data = await market.getBars(symbol, "1M");
      let count = 0;
      for (const bar of data.bars ?? []) {
        const barDate = new Date(Number(bar.time)).toISOString().slice(0, 10);
        if (barDate > date || !(Number(bar.close) > 0)) continue;
        await repo.putBenchmarkClose({ symbol, date: barDate, close: Number(bar.close), source: String(data.source ?? "unknown"), fetchedAt: at });
        count += 1;
      }
      stored[symbol] = count;
    }
    return stored;
  }

  async function intentsByOrder(arm) {
    if (!arm.agentId) return new Map();
    return new Map((await repo.filledIntents(arm.agentId)).filter((row) => row.orderId).map((row) => [row.orderId, row]));
  }

  /** Everything the review and the comparison need about one arm. */
  async function armState(arm) {
    const account = await repositories.accounts.getById(arm.accountId);
    const [snapshots, fills, intents] = await Promise.all([repo.listSnapshots(arm.id), repo.accountFills(arm.accountId), intentsByOrder(arm)]);
    const trips = roundTrips(fills, intents);
    return { arm: { ...arm, startingCash: Number(account.startingCash) }, snapshots, fills, trips };
  }

  async function benchmarks(fromDate) {
    return Object.fromEntries(await Promise.all(BENCHMARKS.map(async (symbol) => [symbol, await repo.listBenchmarkCloses(symbol, fromDate)])));
  }

  async function requireExperiment(id) {
    const experiment = (await repo.getExperiment(id)) ?? (await repo.getExperimentByName(id));
    if (!experiment) throw new AppError("EXPERIMENT_NOT_FOUND", `No experiment ${id}.`, 404);
    return experiment;
  }

  async function comparison(id) {
    const experiment = await requireExperiment(id);
    const arms = await repo.listArms(experiment.id);
    const marks = await benchmarks("0000-00-00");
    const rows = [];
    for (const arm of arms) {
      const state = await armState(arm);
      rows.push(armMetrics({ arm: state.arm, snapshots: state.snapshots, benchmarks: marks, fills: state.fills, closedTrades: state.trips.closed }));
    }
    return { experiment, arms: rows, note: "A comparison, not a verdict. Below 60 trading days the arms are too early to call." };
  }

  async function detail(id) {
    const result = await comparison(id);
    const arms = await repo.listArms(result.experiment.id);
    return {
      ...result,
      armRows: arms,
      reviews: await repo.listReviews(result.experiment.id, 20),
      jobs: await repo.listJobRuns(30)
    };
  }

  return Object.freeze({
    createExperiment, ensureControl, liquidateRetired, snapshot, recordBenchmarks, armState, benchmarks, comparison, detail,
    requireExperiment,
    listExperiments: async () => Promise.all((await repo.listExperiments()).map(async (experiment) => ({ ...experiment, arms: await repo.listArms(experiment.id) })))
  });
}
