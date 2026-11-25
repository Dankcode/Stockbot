/**
 * The swarm review: judges every LLM arm against the experiment's index
 * control, retires the arms that fail, learns from all closed trades, and can
 * start one new arm with a learned Discovery lens.
 *
 * The gauntlet follows docs/CONTROL_GROUP.md, in order:
 *   fails-floor          loss or drawdown past the floor          → retire (any day)
 *   too-early            fewer than MIN_DAYS_TO_CALL trading days  → keep
 *   below-passive        90% bootstrap interval of daily excess
 *                        return vs the control is entirely below 0 → retire
 *   inside-noise         the interval includes 0                   → keep
 *   insufficient-evidence fewer than 5 closed round trips          → keep
 *   worth-recording      interval entirely above 0                 → keep
 * Under-performance inside the noise never retires an arm: that is bad luck,
 * not evidence.
 */
import crypto from "node:crypto";
import { SWARM_CEILINGS } from "../../packages/shared/swarm.js";
import { nextTradingDate, tradingDatesBetween } from "./calendar.js";
import { armMetrics, benchmarkReturn, dailyReturns, MIN_DAYS_TO_CALL } from "./comparison.js";
import { armPlan } from "./experiments.js";
import { learn, lessonsMarkdown, MIN_TRADES } from "./learn.js";

export const REVIEW_EVERY_DAYS = 20;
export const FLOOR_LOSS_PCT = -20;
export const FLOOR_DRAWDOWN_PCT = -25;
export const MIN_CLOSED_TRADES = 5;
const BOOTSTRAP_SAMPLES = 2_000;
const BLOCK = 5;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic moving-block bootstrap 90% interval of the mean. */
export function bootstrapInterval(values, { samples = BOOTSTRAP_SAMPLES, block = BLOCK, seed = 7 } = {}) {
  if (values.length < 2) return null;
  const random = mulberry32(seed);
  const means = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let offset = 0; offset < block && count < values.length; offset += 1) {
        total += values[(start + offset) % values.length];
        count += 1;
      }
    }
    means.push(total / count);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(samples * 0.05)], means[Math.floor(samples * 0.95)]];
}

/** Daily return of the arm minus the control's, on the dates both have a snapshot. */
export function dailyExcess(arm, armSnapshots, control, controlSnapshots) {
  const controlByDate = new Map(controlSnapshots.map((row) => [row.date, row.equity]));
  const shared = armSnapshots.filter((row) => controlByDate.has(row.date));
  const armReturns = dailyReturns(arm.startingCash, shared.map((row) => row.equity));
  const controlReturns = dailyReturns(control.startingCash, shared.map((row) => controlByDate.get(row.date)));
  return armReturns.map((value, index) => value - controlReturns[index]);
}

export function judgeArm({ metrics, excess, tradingDays }) {
  if ((metrics.returnPct ?? 0) <= FLOOR_LOSS_PCT || (metrics.maxDrawdownPct ?? 0) <= FLOOR_DRAWDOWN_PCT) {
    return { verdict: "fails-floor", retire: true, interval: null };
  }
  if (tradingDays < MIN_DAYS_TO_CALL) return { verdict: "too-early", retire: false, interval: null };
  const interval = bootstrapInterval(excess);
  if (interval && interval[1] < 0) return { verdict: "below-passive", retire: true, interval };
  if (!interval || interval[0] <= 0) return { verdict: "inside-noise", retire: false, interval };
  if (metrics.closedTrades < MIN_CLOSED_TRADES) return { verdict: "insufficient-evidence", retire: false, interval };
  return { verdict: "worth-recording", retire: false, interval };
}

export function createReviewService({ repositories, experiments, swarm, clock = () => Date.now(), idFactory = () => crypto.randomUUID() }) {
  const repo = repositories.swarmExperiments;

  async function audit(action, entityId, detail) {
    await repositories.audit.append({ id: idFactory(), at: clock(), actor: "swarm-review", action, entity: "swarm_arm", entityId, detail });
  }

  async function retire(arm, verdict) {
    if (!(await repo.retireArm(arm.id, { reason: verdict, at: clock() }))) return false;
    if (arm.agentId) {
      const agent = await repositories.swarm.getAgent(arm.agentId);
      if (agent && agent.status !== "retired") await swarm.setAgentStatus(arm.agentId, "retired");
    }
    await audit("swarm_arm_retired", arm.id, { label: arm.label, verdict });
    return true;
  }

  /** Every closed trade of every LLM arm, with its return relative to SPY over the same days. */
  function tradesForLearning(states, spy) {
    const trades = [];
    for (const state of states) {
      if (state.arm.kind !== "agent") continue;
      for (const trade of state.trips.closed) {
        const spyReturn = benchmarkReturn(spy, trade.entryDate, trade.exitDate);
        const excessPct = trade.returnPct === null || spyReturn === null ? null : trade.returnPct - spyReturn * 100;
        trades.push({ ...trade, excessPct, arm: state.arm.label });
      }
    }
    return trades;
  }

  async function createLearnedArm(experiment, review, model, date) {
    const existing = (await repo.listArms(experiment.id)).filter((arm) => arm.configJson.lens === "learned");
    const version = existing.length + 1;
    const agentName = `${experiment.name}-learned${version}`;
    if (await repositories.swarm.countAgents() >= SWARM_CEILINGS.maxAgents) return { skipped: `The swarm already has ${SWARM_CEILINGS.maxAgents} agents.` };
    if (await repositories.swarm.getAgentByName(agentName)) return { skipped: `Agent ${agentName} already exists.` };
    const startDate = nextTradingDate(date);
    const plan = armPlan({ experiment: experiment.name, lens: "learned", top: experiment.configJson.top, learned: model, template: experiment.configJson.template ?? {} });
    swarm.validatePlan(plan);
    const agent = await swarm.createAgent({ name: agentName, description: `Experiment ${experiment.name}: learned lens ${model.modelId}` }, "operator");
    await swarm.savePlan(agent.id, plan, { actor: "operator" });
    const arm = await repo.insertArm({
      id: idFactory(), experimentId: experiment.id, label: `disc-learned-v${version}`, kind: "agent", agentId: agent.id, accountId: agent.accountId,
      startDate, config: { lens: "learned", top: experiment.configJson.top, modelId: model.modelId, base: model.base }, createdBy: "review", sourceReviewId: review.id, createdAt: clock()
    });
    await audit("swarm_arm_created", arm.id, { label: arm.label, modelId: model.modelId, reviewId: review.id });
    return { arm, agentName, startDate };
  }

  /**
   * Runs on a trading date after the close. Every day: the floor check. Every
   * REVIEW_EVERY_DAYS trading days (or when forced): the full gauntlet, the
   * learning pass and, when it finds something stable, a new learned arm.
   */
  async function run(experimentId, date, { force = false } = {}) {
    const experiment = await experiments.requireExperiment(experimentId);
    if (experiment.status !== "active") return { skipped: "experiment stopped" };
    const tradingDays = tradingDatesBetween(experiment.startDate, date).length;
    const scheduled = force || (tradingDays > 0 && tradingDays % REVIEW_EVERY_DAYS === 0);
    const arms = await repo.listArms(experiment.id);
    const states = await Promise.all(arms.map((arm) => experiments.armState(arm)));
    const control = states.find((state) => state.arm.kind === "control");
    if (!control) return { skipped: "no control arm" };
    const marks = await experiments.benchmarks("0000-00-00");
    const controlMetrics = armMetrics({ arm: control.arm, snapshots: control.snapshots, benchmarks: marks, fills: control.fills });

    const verdicts = [];
    for (const state of states) {
      const metrics = armMetrics({ arm: state.arm, snapshots: state.snapshots, benchmarks: marks, fills: state.fills, closedTrades: state.trips.closed });
      const row = {
        armId: state.arm.id, label: state.arm.label, kind: state.arm.kind, status: state.arm.status,
        returnPct: metrics.returnPct, maxDrawdownPct: metrics.maxDrawdownPct, closedTrades: metrics.closedTrades,
        excessVsControlPct: metrics.returnPct === null || controlMetrics.returnPct === null ? null : Number((metrics.returnPct - controlMetrics.returnPct).toFixed(2)),
        tradingDays: metrics.tradingDays
      };
      if (state.arm.kind === "control") { verdicts.push({ ...row, verdict: "control", action: "never retired" }); continue; }
      if (state.arm.status !== "active") { verdicts.push({ ...row, verdict: state.arm.retireReason ?? "retired", action: "already retired" }); continue; }
      const excess = dailyExcess(state.arm, state.snapshots, control.arm, control.snapshots);
      const judged = judgeArm({ metrics, excess, tradingDays: metrics.tradingDays });
      // Only the floor can act between scheduled reviews.
      const act = judged.retire && (scheduled || judged.verdict === "fails-floor");
      if (act) await retire(state.arm, judged.verdict);
      verdicts.push({ ...row, verdict: judged.verdict, interval: judged.interval, action: act ? "retired; sleeve sold next session" : "keeps running" });
    }
    const retired = verdicts.filter((row) => row.action.startsWith("retired"));
    if (!scheduled && !retired.length) return { reviewed: false, tradingDays, verdicts };

    let lessons = { tradeCount: 0, features: [], rules: [], weightChanges: [], reason: "Learning waits for the scheduled review.", base: null };
    let model = null;
    let notes = null;
    if (scheduled) {
      const trades = tradesForLearning(states, marks.SPY ?? []);
      const ranked = verdicts.filter((row) => row.kind === "agent" && row.excessVsControlPct !== null)
        .sort((a, b) => b.excessVsControlPct - a.excessVsControlPct);
      const best = ranked.map((row) => states.find((state) => state.arm.id === row.armId)).find(Boolean);
      const base = best?.arm.configJson.base ?? (["growth", "hold"].includes(best?.arm.configJson.lens) ? best.arm.configJson.lens : "growth");
      if (tradingDays < MIN_DAYS_TO_CALL) {
        lessons = { ...lessons, base, tradeCount: trades.filter((trade) => trade.features).length, reason: `Learning starts at ${MIN_DAYS_TO_CALL} trading days; this is day ${tradingDays}.` };
      } else {
        ({ model, lessons } = learn({ trades, base, modelId: `${experiment.name}-learned-${date}` }));
      }
      const scoredTrades = trades.filter((trade) => trade.excessPct !== null).sort((a, b) => b.excessPct - a.excessPct);
      notes = { winners: scoredTrades.slice(0, 3), losers: scoredTrades.slice(-3).reverse().filter((trade) => trade.excessPct < 0) };
    }
    const review = { id: idFactory() };
    const inserted = await repo.insertReview({
      id: review.id, experimentId: experiment.id, asOfDate: date, tradingDays,
      verdicts, lessons, lessonsMd: "", createdAt: clock()
    });
    if (!inserted) return { reviewed: false, duplicate: true, tradingDays, verdicts };
    let created = null;
    if (model && lessons.tradeCount >= MIN_TRADES) created = await createLearnedArm(experiment, review, model, date);
    if (created?.arm) await repo.setReviewArm(review.id, created.arm.id);
    const markdown = lessonsMarkdown({
      asOfDate: date, tradingDays, verdicts, lessons, notes,
      createdArm: created?.arm ? { label: created.arm.label, agentName: created.agentName, startDate: created.startDate } : null
    }) + (created?.skipped ? `\n\nA learned arm was not started: ${created.skipped}` : "")
      + (created?.arm ? `\n\nTo run it, give agent ${created.agentName} a token and a Hermes profile on the Hermes host: \`npm run swarm -- token ${created.agentName}\`, then the printed hermes commands, then schedule \`npm run swarm:worker -- --profile sb-${created.agentName}\`.` : "");
    await repo.setReviewMarkdown(review.id, markdown);
    return { reviewed: true, reviewId: review.id, tradingDays, verdicts, lessons, createdArm: created?.arm ?? null, skipped: created?.skipped ?? null, markdown };
  }

  return Object.freeze({ run });
}
