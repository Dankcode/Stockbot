import crypto from "node:crypto";
import { IntentSubmissionSchema, SWARM_CEILINGS } from "../../packages/shared/swarm.js";
import { AppError } from "../http/errors.js";
import { canonicalHash } from "../research/canonical.js";
import { createRiskEngine } from "../risk/engine.js";
import { DEFAULT_RISK_PROFILE } from "../risk/profile.js";

const TERMINAL = new Set(["filled", "rejected", "broker_rejected"]);
const OPEN = ["received", "submitting"];
// An intent left unfinished longer than this is never traded in the background:
// a minutes-old decision at a new price is not what the agent asked for. The
// sweep records an order the ledger already has, and otherwise closes it out.
export const STRANDED_INTENT_MS = 5 * 60 * 1_000;

/** Agent sleeves keep the standard guardrails, tightened to the swarm ceilings. */
export const AGENT_RISK_PROFILE = Object.freeze({
  ...DEFAULT_RISK_PROFILE,
  id: "swarm-agent",
  name: "Swarm agent sleeve",
  rules: {
    ...DEFAULT_RISK_PROFILE.rules,
    maxPositionSize: { enabled: true, percentOfEquity: SWARM_CEILINGS.maxPositionPercent },
    maxSymbolExposure: { enabled: true, percentOfEquity: SWARM_CEILINGS.maxPositionPercent },
    maxConcurrentPositions: { enabled: true, count: SWARM_CEILINGS.maxOpenPositions },
    maxOrdersPerDay: { enabled: true, count: SWARM_CEILINGS.maxIntentsPerDay }
  }
});

function startOfUtcDay(at) {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Serializes work per sleeve. Sizing reads the portfolio and the broker writes
 * the fill; without this two concurrent buys both see the pre-trade portfolio
 * and together exceed the position cap. The in-process lock covers one process;
 * on PostgreSQL a transaction-scoped advisory lock also covers several Stockbot
 * processes sharing the database (the broker's own writes use other pooled
 * connections, so holding the lock transaction open does not block them).
 */
function createKeyedLock() {
  const tails = new Map();
  return async (key, task) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(key, tail);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function createIntentService({
  client,
  repositories,
  market,
  broker,
  ledger,
  swarm,
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID()
}) {
  const repo = repositories.swarm;
  const riskEngine = createRiskEngine(AGENT_RISK_PROFILE);
  const withLocalLock = createKeyedLock();
  const withSleeveLock = (accountId, task) => withLocalLock(accountId, () => (
    client?.dialect === "postgres"
      ? client.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtext(?))", [`stockbot:sleeve:${accountId}`]);
        return task();
      })
      : task()
  ));

  function result(intent, extra = {}) {
    return {
      intent: {
        id: intent.id, status: intent.status, symbol: intent.symbol, side: intent.side, qty: intent.qty,
        notionalCents: intent.notionalCents, orderId: intent.orderId, clientOrderId: intent.clientOrderId,
        rejectCode: intent.rejectCode, rejectMessage: intent.rejectMessage, attempts: intent.attempts
      },
      ...extra
    };
  }

  async function audit(intent, action, detail) {
    await repositories.audit.append({
      id: idFactory(), at: clock(), actor: `agent:${intent.agentId}`, action, entity: "agent_intent", entityId: intent.id, detail
    });
  }

  async function reject(intent, code, message) {
    const applied = await repo.transitionIntent(intent.id, OPEN, { status: "rejected", rejectCode: code, rejectMessage: message, at: clock() });
    const current = await repo.getIntent(intent.id);
    if (applied) await audit(intent, "agent_intent_rejected", { code, message });
    return result(current, applied ? {} : { idempotent: true });
  }

  async function finalize(intent, execution) {
    const status = execution.order.status === "filled" ? "filled" : "broker_rejected";
    const applied = await repo.transitionIntent(intent.id, OPEN, {
      status,
      orderId: execution.order.id,
      rejectCode: status === "filled" ? null : execution.order.rejectReason ?? execution.rejection?.code ?? "rejected",
      rejectMessage: status === "filled" ? null : execution.rejection?.message ?? null,
      at: clock()
    });
    if (applied) await audit(intent, `agent_intent_${status}`, { orderId: execution.order.id, decisionId: intent.decisionId });
    return result(await repo.getIntent(intent.id), { order: execution.order });
  }

  /** Every gate that must still hold at the moment an order would be sent. */
  async function gate(agent, intent) {
    if (!(await swarm.globalIntentsEnabled())) return ["intents_disabled", "Order intents are disabled for the swarm by the operator."];
    const fresh = await repo.getAgent(agent.id);
    if (!fresh.intentsEnabled) return ["intents_disabled", "Order intents are disabled for this agent by the operator."];
    if (fresh.status !== "active") return ["agent_not_active", `Agent is ${fresh.status}.`];
    const decision = intent.decisionId ? await repo.getDecision(intent.decisionId) : null;
    if (!decision || decision.agentId !== agent.id) return ["decision_not_found", "The decision is missing or belongs to another agent."];
    if (decision.symbol !== intent.symbol) return ["decision_mismatch", "The decision is for a different symbol."];
    if (decision.action !== intent.side) return ["decision_mismatch", `The decision was ${decision.action}, not ${intent.side}.`];
    if (clock() - decision.createdAt > SWARM_CEILINGS.maxReportAgeMs) return ["decision_stale", "The decision is older than 24 hours."];
    if (await repo.countLiveIntentsForDecision(decision.id, intent.id) > 0) return ["decision_already_used", "This decision already backs an order intent."];
    const plan = await repo.getActivePlan(agent.id);
    if (!plan?.planJson.universe.symbols.includes(intent.symbol)) return ["symbol_not_in_plan", "The symbol is outside the active plan."];
    if (intent.side === "buy" && !(Number(decision.score) >= plan.planJson.decision.minScore)) {
      return ["score_below_plan", `A buy needs a score of at least ${plan.planJson.decision.minScore} under the active plan.`];
    }
    return { plan: plan.planJson };
  }

  async function size(agent, intent, plan) {
    const quote = await market.getQuote(intent.symbol, { fresh: true });
    const price = Number(quote?.price);
    if (quote?.status !== "real" || !(price > 0)) return { error: ["market_data_unavailable", "A fresh real quote is required."] };
    const portfolio = await broker.portfolio(agent.accountId);
    const equityCents = Number(portfolio.equity ?? portfolio.cash);
    const position = portfolio.positions.find((entry) => entry.symbol === intent.symbol);
    const notionalCents = intent.notionalCents == null ? null : Number(intent.notionalCents);
    if (notionalCents !== null && notionalCents < 1) return { error: ["notional_too_small", "The notional must be at least one cent."] };
    if (intent.side === "buy") {
      const percent = Math.min(SWARM_CEILINGS.maxPositionPercent, plan.decision.positionPercent);
      if (notionalCents + Number(position?.marketValue ?? 0) > equityCents * (percent / 100)) {
        return { error: ["max_position_ceiling", `A position may not exceed ${percent}% of sleeve equity under the active plan.`] };
      }
      const maxPositions = Math.min(SWARM_CEILINGS.maxOpenPositions, plan.requestedLimits?.maxPositions ?? Infinity);
      if (!position && portfolio.positions.length >= maxPositions) {
        return { error: ["max_open_positions", `A sleeve may hold at most ${maxPositions} positions under the active plan.`] };
      }
      const qty = Math.floor((notionalCents / 100 / price) * 1_000_000);
      return qty > 0 ? { qty, quote } : { error: ["notional_too_small", "The notional buys less than one micro-share."] };
    }
    if (!position) return { error: ["no_position", "Long-only: there is no position to sell."] };
    const held = Number(position.qty);
    const requested = notionalCents === null ? held : Math.floor((notionalCents / 100 / price) * 1_000_000);
    const qty = Math.min(held, requested);
    return qty > 0 ? { qty, quote } : { error: ["notional_too_small", "The notional sells less than one micro-share."] };
  }

  async function send(agent, intent, qty, quote) {
    const applied = await repo.transitionIntent(intent.id, OPEN, { status: "submitting", qty, attempt: true, at: clock() });
    if (!applied) return result(await repo.getIntent(intent.id), { idempotent: true });
    const submitting = await repo.getIntent(intent.id);
    const execution = await broker.submitOrder({
      clientOrderId: intent.clientOrderId,
      accountId: agent.accountId,
      symbol: intent.symbol,
      side: intent.side,
      qty,
      quote,
      riskEngine,
      signalReason: `agent:${agent.name} decision:${intent.decisionId}`
    });
    return finalize(submitting, execution);
  }

  async function process(agent, intent) {
    const gated = await gate(agent, intent);
    if (Array.isArray(gated)) return reject(intent, ...gated);
    const maxPerDay = Math.min(SWARM_CEILINGS.maxIntentsPerDay, gated.plan.requestedLimits?.maxIntentsPerDay ?? Infinity);
    if (await repo.countIntentsSince(agent.id, startOfUtcDay(clock())) > maxPerDay) {
      return reject(intent, "max_intents_per_day", `At most ${maxPerDay} intents per day under the active plan.`);
    }
    let sized;
    try { sized = await size(agent, intent, gated.plan); }
    catch (error) { return reject(intent, "market_data_unavailable", error.message); }
    if (sized.error) return reject(intent, ...sized.error);
    return send(agent, intent, sized.qty, sized.quote);
  }

  /**
   * Brings an intent to a terminal state without ever creating a second order:
   * the client order id is derived from the intent id and the ledger is unique on
   * it, so a retry either finds the order already written or sends the first one.
   * `background` is the sweep: it records what the ledger has and never trades.
   */
  async function reconcile(agent, intent, { background = false } = {}) {
    if (TERMINAL.has(intent.status)) return result(intent, { idempotent: true });
    const existing = await ledger.getExecution(intent.clientOrderId);
    if (existing) return finalize(intent, existing);
    if (background) {
      return intent.status === "submitting"
        ? reject(intent, "submission_interrupted", "Submission was interrupted before the ledger recorded an order; nothing was traded.")
        : reject(intent, "stale_received", "The intent was never processed and is too old to trade now; nothing was traded.");
    }
    if (intent.status === "submitting") {
      const gated = await gate(agent, intent);
      if (Array.isArray(gated)) return reject(intent, ...gated);
      return send(agent, intent, Number(intent.qty), undefined);
    }
    return process(agent, intent);
  }

  async function submit(agent, input) {
    const parsed = IntentSubmissionSchema.safeParse(input);
    if (!parsed.success) throw new AppError("INTENT_INVALID", "Request validation failed.", 422, parsed.error.flatten());
    const { idempotencyKey, ...request } = parsed.data;
    const requestHash = canonicalHash(request);
    return withSleeveLock(agent.accountId, async () => {
      const existing = await repo.getIntentByKey(agent.id, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError("IDEMPOTENCY_KEY_REUSED", "That idempotency key was used for a different intent.", 409);
        return reconcile(agent, existing);
      }
      const id = idFactory();
      const intent = await repo.insertIntent({
        id, agentId: agent.id, decisionId: request.decisionId, idempotencyKey, requestHash, symbol: request.symbol, side: request.side,
        notionalCents: request.notional === undefined ? null : Math.round(request.notional * 100), clientOrderId: `intent:${id}`, createdAt: clock()
      });
      if (intent.id !== id) return reconcile(agent, intent);
      return process(agent, intent);
    });
  }

  /** Background sweep: no intent stays unfinished, and none is traded late. */
  async function reconcileStranded() {
    const rows = await repo.listIntentsByStatus(OPEN, clock() - STRANDED_INTENT_MS);
    const outcomes = [];
    for (const row of rows) {
      const agent = await repo.getAgent(row.agentId);
      outcomes.push(await withSleeveLock(agent.accountId, async () => reconcile(agent, await repo.getIntent(row.id), { background: true })));
    }
    return outcomes;
  }

  return Object.freeze({ submit, reconcile, reconcileStranded, riskEngine });
}
