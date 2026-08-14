import { createHash, randomUUID } from "node:crypto";
import {
  ResearchPlanSchema,
  ResearchSnapshotSchema
} from "../../packages/shared/research.js";
import { createRepositories } from "../db/repositories/index.js";
import { computeMetrics } from "../engine/metrics.js";
import { AppError } from "../http/errors.js";
import { createRiskEngine } from "../risk/engine.js";
import { SessionScheduler } from "./scheduler.js";
import {
  EXCHANGE_TIMEZONE,
  epochForZonedDateTime,
  scheduleAllows,
  validateSchedule,
  zonedDateTimeParts
} from "./schedules.js";
import { transitionSession } from "./state-machine.js";
import { DEFAULT_ACCOUNT_ID, dollarsToCents, notionalCents } from "../broker/ledger.js";
import { isCryptoSymbol } from "../market/catalog.js";
import {
  normalizeResearchTimeline,
  selectResearchFrame
} from "../research/timeline.js";

const ACTIVE_STATUSES = Object.freeze(["arming", "running", "paused", "stopping"]);
const METRIC_KEYS = Object.freeze([
  "returnPercent",
  "finalEquity",
  "maxDrawdown",
  "sharpe",
  "sortino",
  "profitFactor",
  "winRate",
  "tradeCount",
  "exposurePercent",
  "avgTradePercent"
]);
const CONFIG_KEYS = Object.freeze([
  "algorithmVersionId",
  "researchPlanVersionId",
  "paramsJson",
  "symbolsJson",
  "barInterval",
  "windowStart",
  "windowEnd",
  "fillModelJson",
  "riskProfileJson",
  "scheduleJson"
]);

const INTERVAL_MS = Object.freeze({
  "1min": 60_000,
  "5min": 5 * 60_000,
  "15min": 15 * 60_000,
  "30min": 30 * 60_000,
  "1hour": 60 * 60_000,
  "1day": 24 * 60 * 60_000,
  "1week": 7 * 24 * 60 * 60_000
});

function rangeForInterval(interval) {
  return {
    "1min": "1H",
    "5min": "1D",
    "15min": "1D",
    "30min": "1W",
    "1hour": "1W",
    "1day": "3M",
    "1week": "1Y",
    "1month": "ALL"
  }[interval];
}

function asAt(value, fallback) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function notFound(id) {
  return new AppError("SESSION_NOT_FOUND", `Unknown session: ${id}`, 404);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeCurve(points) {
  const baseline = Number(points[0]?.equity);
  return points.map((point) => ({
    at: point.at,
    value: baseline > 0 ? (Number(point.equity) / baseline) * 100 : 100,
    equity: Number(point.equity)
  }));
}

function downsample(points, target) {
  if (!target || points.length <= target) return points;
  const count = Math.max(2, Math.trunc(target));
  const result = [points[0]];
  const step = (points.length - 1) / (count - 1);
  for (let index = 1; index < count - 1; index += 1) result.push(points[Math.round(index * step)]);
  result.push(points.at(-1));
  return result;
}

function barEnd(barTime, interval) {
  if (interval === "1month") {
    const end = new Date(barTime);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return end.getTime();
  }
  return barTime + (INTERVAL_MS[interval] ?? 0);
}

function dailyExchangeClose(barTime) {
  const utc = new Date(barTime);
  const isUtcMidnight = utc.getUTCHours() === 0 && utc.getUTCMinutes() === 0 &&
    utc.getUTCSeconds() === 0 && utc.getUTCMilliseconds() === 0;
  const date = isUtcMidnight
    ? { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
    : zonedDateTimeParts(barTime, EXCHANGE_TIMEZONE);
  return epochForZonedDateTime({ ...date, hour: 16, minute: 0, second: 0 }, EXCHANGE_TIMEZONE);
}

function exchangeBarOpen(barTime) {
  const utc = new Date(barTime);
  const isUtcMidnight = utc.getUTCHours() === 0 && utc.getUTCMinutes() === 0 &&
    utc.getUTCSeconds() === 0 && utc.getUTCMilliseconds() === 0;
  const date = isUtcMidnight
    ? { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
    : zonedDateTimeParts(barTime, EXCHANGE_TIMEZONE);
  return epochForZonedDateTime({ ...date, hour: 9, minute: 30, second: 0 }, EXCHANGE_TIMEZONE);
}

function realClosedBars(historical, interval, at, symbol, trigger) {
  if (!historical?.bars?.length || historical.source === "unavailable") return [];
  const bars = historical.bars
    .map((bar) => ({ ...bar, time: typeof bar.time === "number" ? bar.time : Date.parse(bar.time) }))
    .filter((bar) => Number.isSafeInteger(bar.time) && bar.time <= at)
    .sort((left, right) => left.time - right.time);
  return bars.filter((bar, index) => {
    const next = bars[index + 1];
    if (next && next.time <= at) return true;
    const closesNow = (trigger?.kind === "market" && trigger.phase === "close") ||
      trigger?.coalescedBarPhase === "close";
    if (interval === "1day" && !isCryptoSymbol(symbol)) {
      if (closesNow && trigger.interval === interval) return true;
      return dailyExchangeClose(bar.time) <= at;
    }
    if (["1week", "1month"].includes(interval) && !isCryptoSymbol(symbol) &&
        closesNow && trigger.interval === interval) {
      return true;
    }
    return barEnd(bar.time, interval) <= at;
  });
}

function barTime(bar) {
  return typeof bar.time === "number" ? bar.time : Date.parse(bar.time);
}

function barsHash(bars) {
  const normalized = bars.map((bar) => ({
    time: barTime(bar),
    open: Number(bar.open),
    high: Number(bar.high),
    low: Number(bar.low),
    close: Number(bar.close),
    volume: Number(bar.volume ?? 0)
  }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function intervalSpan(interval, at) {
  if (interval !== "1month") return INTERVAL_MS[interval] ?? 0;
  const start = new Date(at);
  const end = new Date(at);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return end.getTime() - start.getTime();
}

function nextOpenTolerance(interval, settleDelayMs) {
  const intervalAllowance = Math.min(5_000, Math.max(1_000, intervalSpan(interval, 0) * 0.02));
  return Math.max(intervalAllowance, Number(settleDelayMs) + 1_000);
}

export function createSupervisor({
  client,
  repositories = createRepositories(client),
  market,
  enginePool,
  ledger,
  broker,
  scheduler = new SessionScheduler(),
  eventHub,
  alertEvaluator,
  restartRunningSessions = false,
  settleDelayMs = 2_000,
  clock = () => Date.now(),
  idFactory = randomUUID,
  metricsVersion = "v1"
}) {
  if (!client || !market || !enginePool || !ledger || !broker) {
    throw new TypeError("Supervisor requires client, market, enginePool, ledger, and broker services.");
  }
  const algorithmStates = new Map();
  const lastSignalBars = new Map();

  function parseResearchVersion(version, symbols) {
    let plan;
    try {
      plan = ResearchPlanSchema.parse(version.manifestJson);
    } catch (cause) {
      throw new AppError(
        "RESEARCH_PLAN_INVALID",
        `Stored research plan version ${version.id} is invalid.`,
        500,
        { planVersionId: version.id, cause: cause.message }
      );
    }
    if (plan.id !== version.planId) {
      throw new AppError(
        "RESEARCH_PLAN_INVALID",
        `Stored research plan version ${version.id} does not match its plan.`,
        500,
        { planVersionId: version.id, planId: version.planId, manifestPlanId: plan.id }
      );
    }
    if (!plan.delivery.strategy) {
      throw new AppError(
        "RESEARCH_STRATEGY_DISABLED",
        `Research plan ${plan.id} is not enabled for strategy evaluation.`,
        422,
        { planId: plan.id, planVersionId: version.id }
      );
    }
    const unsupported = symbols.filter((symbol) =>
      !plan.symbols.includes("*") && !plan.symbols.includes(symbol)
    );
    if (unsupported.length > 0) {
      throw new AppError(
        "RESEARCH_SYMBOL_NOT_ALLOWED",
        `Research plan ${plan.id} does not allow every session symbol.`,
        422,
        { planId: plan.id, planVersionId: version.id, symbols: unsupported }
      );
    }
    return Object.freeze({
      version,
      plan,
      required: plan.delivery.required
    });
  }

  async function resolveResearchPin(input, symbols) {
    if (input.researchPlanId && input.researchPlanVersionId) {
      throw new AppError(
        "RESEARCH_PIN_AMBIGUOUS",
        "Choose either researchPlanId or researchPlanVersionId, not both.",
        400
      );
    }
    if (!input.researchPlanId && !input.researchPlanVersionId) return null;
    const version = input.researchPlanVersionId
      ? await repositories.research.getPlanVersion(input.researchPlanVersionId)
      : await repositories.research.latestPlanVersion(input.researchPlanId);
    if (!version) {
      throw new AppError(
        "RESEARCH_PLAN_VERSION_NOT_FOUND",
        "Research plan version was not found.",
        404,
        {
          researchPlanId: input.researchPlanId ?? null,
          researchPlanVersionId: input.researchPlanVersionId ?? null
        }
      );
    }
    return parseResearchVersion(version, symbols);
  }

  async function sessionResearch(session) {
    if (!session.researchPlanVersionId) return null;
    const version = await repositories.research.getPlanVersion(session.researchPlanVersionId);
    if (!version) {
      throw new AppError(
        "RESEARCH_PLAN_VERSION_NOT_FOUND",
        `Pinned research plan version ${session.researchPlanVersionId} no longer exists.`,
        404,
        { researchPlanVersionId: session.researchPlanVersionId }
      );
    }
    return parseResearchVersion(version, session.symbolsJson);
  }

  function storedResearchSnapshot(row, research, symbol) {
    let snapshot;
    try {
      snapshot = ResearchSnapshotSchema.parse(row.snapshotJson);
    } catch (cause) {
      throw new AppError(
        "RESEARCH_SNAPSHOT_INVALID",
        `Stored research snapshot ${row.id} is invalid.`,
        500,
        { snapshotId: row.id, cause: cause.message }
      );
    }
    const expected = {
      id: row.id,
      runId: row.runId,
      planVersionId: research.version.id,
      planId: research.plan.id,
      symbol,
      availableAt: Number(row.availableAt)
    };
    const mismatch = Object.entries(expected).find(([key, value]) => snapshot[key] !== value);
    if (mismatch) {
      throw new AppError(
        "RESEARCH_SNAPSHOT_INVALID",
        `Stored research snapshot ${row.id} has inconsistent provenance.`,
        500,
        { snapshotId: row.id, field: mismatch[0] }
      );
    }
    return snapshot;
  }

  async function researchTimelineFor(research, symbol, windowStart, windowEnd) {
    const limit = 5_000;
    const [prior, rows, count] = await Promise.all([
      repositories.research.latestEligibleSnapshot({
        planVersionId: research.version.id,
        symbol,
        availableAt: windowStart
      }),
      repositories.research.timeline({
        planVersionId: research.version.id,
        symbol,
        afterAvailableAt: windowStart,
        beforeAvailableAt: windowEnd,
        limit
      }),
      repositories.research.countTimeline({
        planVersionId: research.version.id,
        symbol,
        afterAvailableAt: windowStart,
        beforeAvailableAt: windowEnd
      })
    ]);
    if (count > rows.length) {
      throw new AppError(
        "RESEARCH_TIMELINE_TOO_LARGE",
        `Research timeline for ${symbol} exceeds the backtest limit.`,
        422,
        {
          planVersionId: research.version.id,
          symbol,
          windowStart,
          windowEnd,
          count,
          limit
        }
      );
    }
    const byId = new Map();
    for (const row of [prior, ...rows]) {
      if (row) byId.set(row.id, storedResearchSnapshot(row, research, symbol));
    }
    return normalizeResearchTimeline([...byId.values()]);
  }

  async function researchFrameAt(research, symbol, decisionAt) {
    if (!research) return null;
    const row = await repositories.research.latestEligibleSnapshot({
      planVersionId: research.version.id,
      symbol,
      availableAt: decisionAt
    });
    return selectResearchFrame({
      timeline: row ? [storedResearchSnapshot(row, research, symbol)] : [],
      symbol,
      decisionAt
    });
  }

  async function evaluateAlert(event, sessionId) {
    if (!alertEvaluator) return [];
    try {
      return await alertEvaluator(event, sessionId);
    } catch (error) {
      eventHub?.publish("alert.error", { sessionId, error: error.message });
      return [];
    }
  }

  async function addSessionEvent(session, type, detail = {}, fromStatus = null, toStatus = null) {
    return repositories.sessions.addEvent({
      id: idFactory(),
      sessionId: session.id,
      at: clock(),
      type,
      fromStatus,
      toStatus,
      detail
    });
  }

  async function appendAudit(action, session, detail = {}, actor = "supervisor") {
    const audit = await repositories.audit.append({
      id: idFactory(),
      at: clock(),
      actor,
      action,
      entity: "session",
      entityId: session.id,
      detail
    });
    eventHub?.publish("session.event", { sessionId: session.id, action, detail });
    return audit;
  }

  async function detail(id) {
    const session = await repositories.sessions.getById(id);
    if (!session) throw notFound(id);
    return { session, metrics: await repositories.sessions.getMetrics(id) };
  }

  async function list(filters = {}) {
    const sessions = await repositories.sessions.list(filters);
    return Promise.all(
      sessions.map(async (session) => ({ ...session, metrics: await repositories.sessions.getMetrics(session.id) }))
    );
  }

  async function get(id) {
    return detail(id);
  }

  async function getEquity(id, { resolution, ...options } = {}) {
    if (!(await repositories.sessions.getById(id))) throw notFound(id);
    const points = await repositories.sessions.getEquity(id, { ...options, limit: options.limit ?? 50_000 });
    const target = resolution == null || resolution === "full" ? null : Number(resolution);
    if (target !== null && (!Number.isInteger(target) || target < 2)) {
      throw new AppError("INVALID_RESOLUTION", "resolution must be full or an integer of at least 2.", 400);
    }
    return downsample(points, target);
  }

  async function getOrders(id, options = {}) {
    if (!(await repositories.sessions.getById(id))) throw notFound(id);
    const orders = await repositories.orders.list({ ...options, sessionId: id, limit: options.limit ?? 250 });
    return Promise.all(
      orders.map(async (order) => ({ ...order, fills: await repositories.orders.listFills({ orderId: order.id }) }))
    );
  }

  async function getEvents(id, options = {}) {
    if (!(await repositories.sessions.getById(id))) throw notFound(id);
    const [audit, risk, state] = await Promise.all([
      repositories.audit.list({ entity: "session", entityId: id, limit: options.limit ?? 250 }),
      repositories.risk.listEvents({ sessionId: id, limit: options.limit ?? 250 }),
      repositories.sessions.listEvents(id, { limit: options.limit ?? 250 })
    ]);
    return [
      ...audit.map((event) => ({ type: "audit", at: event.at, ...event })),
      ...risk.map((event) => ({ type: "risk", at: event.at, ...event })),
      ...state.map((event) => ({ type: "session_state", at: event.at, ...event }))
    ].sort((left, right) => Number(right.at) - Number(left.at));
  }

  async function compare(ids) {
    const unique = [...new Set(ids ?? [])];
    if (unique.length < 2 || unique.length > 4) {
      throw new AppError("INVALID_COMPARE_COUNT", "Compare requires two to four distinct session IDs.", 400);
    }
    const items = await Promise.all(
      unique.map(async (id) => {
        const value = await detail(id);
        const equity = await getEquity(id, { resolution: 1_500 });
        return { ...value, equity, normalizedEquity: normalizeCurve(equity) };
      })
    );
    const metricMatrix = Object.fromEntries(
      METRIC_KEYS.map((key) => [key, Object.fromEntries(items.map(({ session, metrics }) => [session.id, metrics?.[key] ?? null]))])
    );
    const configDiff = {};
    for (const key of CONFIG_KEYS) {
      const values = Object.fromEntries(items.map(({ session }) => [session.id, session[key]]));
      const first = values[unique[0]];
      if (unique.some((id) => !stableEqual(values[id], first))) configDiff[key] = values;
    }
    const curves = items.map(({ session, normalizedEquity }) => ({
      sessionId: session.id,
      points: normalizedEquity.map((point) => ({ at: point.at, equity: point.value }))
    }));
    return {
      ids: unique,
      sessions: items.map(({ session, metrics }) => ({ ...session, metrics })),
      curves,
      normalizedCurves: curves,
      metricMatrix,
      configDiff,
      details: items
    };
  }

  async function exportData(id) {
    const value = await detail(id);
    const [equity, orders, events, completionEntries] = await Promise.all([
      getEquity(id, {}),
      getOrders(id),
      getEvents(id),
      repositories.audit.list({
        action: "session_complete",
        entity: "session",
        entityId: id,
        limit: 1
      })
    ]);
    const completion = completionEntries[0];
    return {
      ...value,
      equity,
      orders,
      events,
      backtestConfig: completion?.detailJson?.backtestConfig ?? null,
      exportedAt: clock(),
      formatVersion: 1
    };
  }

  async function create(input) {
    const schedule = validateSchedule(input.schedule ?? { type: "manual", timezone: "UTC" });
    const research = await resolveResearchPin(input, input.symbols);
    const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
    if (accountId === DEFAULT_ACCOUNT_ID) await broker.ensureDefaultAccount();
    const account = await repositories.accounts.getById(accountId);
    if (!account) throw new AppError("ACCOUNT_NOT_FOUND", `Unknown account: ${accountId}`, 404);
    const accountPortfolio = await broker.portfolio(accountId, { fresh: false, at: clock() });
    const session = await repositories.sessions.create({
      id: input.id ?? idFactory(),
      accountId,
      name: input.name,
      mode: input.mode,
      status: "draft",
      algorithmVersionId: input.algorithmVersionId ?? null,
      researchPlanVersionId: research?.version.id ?? null,
      params: input.params ?? {},
      symbols: input.symbols,
      barInterval: input.barInterval,
      windowStart: input.windowStart ?? null,
      windowEnd: input.windowEnd ?? null,
      fillModel: input.fillModel ?? { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 },
      riskProfile: input.riskProfile ?? {},
      schedule,
      startingEquity: input.startingEquity ?? accountPortfolio.equity ?? account.cash,
      createdAt: input.createdAt ?? clock()
    });
    await appendAudit("session_created", session, {
      mode: session.mode,
      symbols: session.symbolsJson,
      researchPlanVersionId: session.researchPlanVersionId
    }, "user");
    return session;
  }

  async function transition(id, event, options = {}, actor = "user") {
    const current = await repositories.sessions.getById(id);
    if (!current) throw notFound(id);
    const status = transitionSession(current.status, event);
    if (status === current.status) return current;
    const next = await repositories.sessions.transition(id, status, { ...options, from: current.status });
    if (!next) throw new AppError("SESSION_TRANSITION_RACE", "Session state changed concurrently.", 409);
    await addSessionEvent(next, "state_transition", options, current.status, status);
    await appendAudit(`session_${event}`, next, { from: current.status, to: status, ...options }, actor);
    eventHub?.publish("session.state", { session: next });
    await evaluateAlert({ type: "session_state", status, previousStatus: current.status, sessionId: id }, id);
    return next;
  }

  async function preflight(session) {
    if (!session.algorithmVersionId) throw new AppError("ALGORITHM_REQUIRED", "Session requires an algorithm version.", 400);
    const version = await repositories.algorithms.getVersion(session.algorithmVersionId);
    if (!version) throw new AppError("ALGORITHM_VERSION_NOT_FOUND", "Algorithm version no longer exists.", 404);
    await enginePool.validateAlgorithm({ algorithmSource: version.sourceCode, filename: `${version.algorithmId}.js` });
    createRiskEngine(session.riskProfileJson);
    validateSchedule(session.scheduleJson);
    const research = await sessionResearch(session);
    const range = rangeForInterval(session.barInterval);
    if (!range) throw new AppError("INVALID_BAR_INTERVAL", `Unsupported interval: ${session.barInterval}`, 400);
    const marketData = await Promise.all(
      session.symbolsJson.map(async (symbol) => {
        const historical = await market.getBars(symbol, range);
        if (!historical?.bars?.length || historical.source === "unavailable") {
          throw new AppError("MARKET_DATA_UNAVAILABLE", `No real bars available for ${symbol}.`, 503);
        }
        const filteredBars = historical.bars.filter((bar) => {
          const time = barTime(bar);
          return Number.isSafeInteger(time) &&
            (session.windowStart == null || time >= Number(session.windowStart)) &&
            (session.windowEnd == null || time <= Number(session.windowEnd));
        });
        if (filteredBars.length === 0) {
          throw new AppError("BACKTEST_WINDOW_EMPTY", `No bars for ${symbol} fall inside the requested window.`, 422, {
            windowStart: session.windowStart,
            windowEnd: session.windowEnd
          });
        }
        const researchTimeline = session.mode === "backtest" && research
          ? await researchTimelineFor(
              research,
              symbol,
              barTime(filteredBars[0]),
              barTime(filteredBars.at(-1))
            )
          : Object.freeze([]);
        return {
          symbol,
          historical: { ...historical, bars: filteredBars },
          windowStart: barTime(filteredBars[0]),
          windowEnd: barTime(filteredBars.at(-1)),
          barsHash: barsHash(filteredBars),
          researchTimeline
        };
      })
    );
    return { version, marketData, research };
  }

  function combineBacktests(results, startingCash) {
    if (results.length === 1) return results[0].result;
    const length = Math.min(...results.map(({ result }) => result.equityCurve.length));
    const equityCurve = Array.from({ length }, (_, index) => ({
      time: results[0].result.equityCurve[index].time,
      equity: results.reduce((sum, item) => sum + Number(item.result.equityCurve[index].equity), 0),
      cash: results.reduce((sum, item) => sum + Number(item.result.equityCurve[index].cash), 0),
      positionValue: results.reduce((sum, item) => sum + Number(item.result.equityCurve[index].positionValue), 0)
    }));
    const trades = results.flatMap(({ symbol, result }) => result.trades.map((trade) => ({ ...trade, symbol })));
    const exposure = results.reduce((sum, item) => sum + item.result.metrics.exposurePercent, 0) / results.length;
    const metrics = computeMetrics({
      equityCurve,
      trades,
      startingEquity: startingCash,
      interval: results[0].interval,
      barsInPosition: Math.round(((length - 1) * exposure) / 100),
      totalBars: Math.max(0, length - 1),
      openPosition: results.some((item) => item.result.metrics.openPosition)
    });
    return { equityCurve, trades, metrics };
  }

  async function runBacktest(session, prepared) {
    const allocation = Number(session.startingEquity) / 100 / prepared.marketData.length;
    const results = [];
    for (const {
      symbol,
      historical,
      windowStart,
      windowEnd,
      barsHash: historicalHash,
      researchTimeline
    } of prepared.marketData) {
      const result = await enginePool.runBacktest({
        algorithmSource: prepared.version.sourceCode,
        filename: `${prepared.version.algorithmId}.js`,
        bars: historical.bars,
        params: session.paramsJson,
        startingCash: allocation,
        fillModel: session.fillModelJson,
        interval: session.barInterval,
        windowStart: session.windowStart ?? windowStart,
        windowEnd: session.windowEnd ?? windowEnd,
        barsHash: historicalHash,
        researchTimeline: prepared.research ? researchTimeline : undefined,
        symbol: prepared.research ? symbol : undefined,
        researchRequired: prepared.research?.required ?? false
      });
      results.push({ symbol, interval: session.barInterval, result, barsHash: historicalHash });
    }
    const combined = combineBacktests(results, Number(session.startingEquity) / 100);
    const peak = { value: Number(session.startingEquity) };
    const equity = combined.equityCurve.map((point, index) => {
      const amount = Math.round(Number(point.equity) * 100);
      peak.value = Math.max(peak.value, amount);
      return {
        sessionId: session.id,
        at: asAt(point.time, Number(session.windowStart ?? session.createdAt) + index),
        equity: amount,
        cash: Math.round(Number(point.cash ?? point.equity) * 100),
        positionValue: Math.round(Number(point.positionValue ?? 0) * 100),
        drawdownPercent: peak.value > 0 ? ((peak.value - amount) / peak.value) * 100 : 0
      };
    });
    const executions = results.flatMap(({ symbol, result }) =>
      result.trades.map((trade, index) => {
        const orderId = idFactory();
        const at = asAt(trade.time, clock() + index);
        return {
          order: {
            id: orderId,
            clientOrderId: `backtest:${session.id}:${symbol}:${trade.id}`,
            sessionId: session.id,
            researchSnapshotId: trade.researchSnapshotId ?? null,
            accountId: session.accountId,
            symbol,
            side: trade.side,
            qty: Math.max(1, Math.round(Number(trade.quantity) * 1_000_000)),
            status: "filled",
            signalReason: trade.rule ?? null,
            submittedAt: asAt(trade.signalTime, at),
            resolvedAt: at
          },
          fill: {
            id: idFactory(),
            qty: Math.max(1, Math.round(Number(trade.quantity) * 1_000_000)),
            price: dollarsToCents(trade.price),
            referencePrice: dollarsToCents(trade.referencePrice ?? trade.price),
            commission: Math.max(0, Math.round(Number(trade.commission ?? 0) * 100)),
            filledAt: at,
            quoteAgeMs: 0
          }
        };
      })
    );
    const metrics = {
      id: idFactory(),
      sessionId: session.id,
      metricsVersion,
      computedAt: clock(),
      ...combined.metrics,
      finalEquity: Math.round(Number(combined.metrics.finalEquity) * 100),
      sortino: combined.metrics.sortino ?? null
    };
    const persisted = await ledger.persistBacktestResult({
      sessionId: session.id,
      equity,
      executions,
      metrics,
      complete: {
        status: "stopped",
        options: {
          from: "arming",
          endingEquity: metrics.finalEquity,
          endedAt: clock(),
          stopReason: "completed"
        }
      }
    });
    return {
      ...persisted,
      backtestConfig: {
        algorithmVersionId: session.algorithmVersionId,
        researchPlanVersionId: session.researchPlanVersionId ?? null,
        symbols: Object.fromEntries(results.map(({ symbol, result, barsHash: historicalHash }) => [
          symbol,
          {
            barsHash: historicalHash,
            researchTimelineHash: result.researchTimelineHash
          }
        ]))
      }
    };
  }

  async function finalizePaperMetrics(sessionId, endingEquity) {
    const session = await repositories.sessions.getById(sessionId);
    if (!session || session.mode !== "paper") return null;
    const [snapshots, orders, lots, openLots] = await Promise.all([
      repositories.sessions.getEquity(sessionId, { limit: 50_000 }),
      repositories.orders.list({ sessionId, status: "filled", limit: 250 }),
      client.query(
        `SELECT exit_order_id, realized_pnl, entry_price, qty_original
         FROM position_lots
         WHERE session_id = ? AND exit_order_id IS NOT NULL`,
        [sessionId]
      ),
      client.query(
        `SELECT COUNT(*) AS count FROM position_lots
         WHERE session_id = ? AND closed_at IS NULL AND qty_open > 0`,
        [sessionId]
      )
    ]);
    const equityCurve = snapshots.map((point) => ({ time: point.at, equity: Number(point.equity) / 100 }));
    if (equityCurve.length === 0) {
      equityCurve.push({ time: session.startedAt ?? session.createdAt, equity: Number(session.startingEquity) / 100 });
    }
    if (endingEquity != null && Number(endingEquity) !== Math.round(equityCurve.at(-1).equity * 100)) {
      equityCurve.push({ time: clock(), equity: Number(endingEquity) / 100 });
    }
    const exits = new Map();
    for (const lot of lots) {
      const current = exits.get(lot.exit_order_id) ?? { realizedPnl: 0, costBasis: 0 };
      current.realizedPnl += Number(lot.realized_pnl ?? 0);
      current.costBasis += notionalCents(Number(lot.entry_price), Number(lot.qty_original));
      exits.set(lot.exit_order_id, current);
    }
    const trades = orders.map((order) => {
      const exit = exits.get(order.id);
      return {
        side: order.side,
        realizedPnl: exit ? exit.realizedPnl / 100 : 0,
        pnlPercent: exit?.costBasis ? (exit.realizedPnl / exit.costBasis) * 100 : 0
      };
    });
    const computed = computeMetrics({
      equityCurve,
      trades,
      startingEquity: Number(session.startingEquity) / 100,
      interval: session.barInterval,
      barsInPosition: snapshots.filter((point) => Number(point.positionValue) > 0).length,
      totalBars: Math.max(0, snapshots.length - 1),
      openPosition: Number(openLots[0]?.count ?? 0) > 0
    });
    return repositories.sessions.upsertMetrics({
      id: idFactory(),
      sessionId,
      metricsVersion,
      computedAt: clock(),
      returnPercent: computed.returnPercent,
      finalEquity: Math.round(computed.finalEquity * 100),
      maxDrawdown: computed.maxDrawdown,
      sharpe: computed.sharpe,
      sortino: computed.sortino,
      profitFactor: computed.profitFactor,
      winRate: computed.winRate,
      tradeCount: computed.tradeCount,
      exposurePercent: computed.exposurePercent,
      avgTradePercent: computed.avgTradePercent
    });
  }

  function armScheduler(session) {
    scheduler.schedule(
      session.id,
      session.barInterval,
      (trigger) => tick(session.id, trigger),
      { schedule: session.scheduleJson, symbols: session.symbolsJson }
    );
  }

  async function fail(id, error) {
    const current = await repositories.sessions.getById(id);
    if (!current || !ACTIVE_STATUSES.includes(current.status)) return current;
    const failed = await transition(id, "fail", {
      endedAt: clock(),
      stopReason: "error",
      errorDetail: error.message
    });
    scheduler.cancel(id);
    for (const key of algorithmStates.keys()) if (key.startsWith(`${id}:`)) algorithmStates.delete(key);
    for (const key of lastSignalBars.keys()) if (key.startsWith(`${id}:`)) lastSignalBars.delete(key);
    if (failed?.mode === "paper") await finalizePaperMetrics(id, failed.endingEquity);
    return failed;
  }

  async function start(id) {
    let session = await transition(id, "start");
    try {
      const prepared = await preflight(session);
      if (session.mode === "backtest") {
        const completed = await runBacktest(session, prepared);
        const completionDetail = { mode: "backtest", backtestConfig: completed.backtestConfig };
        await addSessionEvent(completed.session, "state_transition", completionDetail, "arming", "stopped");
        await appendAudit("session_complete", completed.session, completionDetail, "engine");
        eventHub?.publish("session.state", { session: completed.session });
        await evaluateAlert({ type: "session_state", status: "stopped", previousStatus: "arming", sessionId: id }, id);
        return completed.session;
      }
      session = await transition(id, "armed", { startedAt: clock() }, "supervisor");
      armScheduler(session);
      return session;
    } catch (error) {
      await fail(id, error);
      throw error;
    }
  }

  async function pause(id) {
    return transition(id, "pause");
  }

  async function resume(id) {
    const session = await transition(id, "resume");
    armScheduler(session);
    return session;
  }

  async function stop(id, options = {}) {
    let current = await repositories.sessions.getById(id);
    if (!current) throw notFound(id);
    if (current.status === "stopped") return current;
    current = await transition(id, "stop");
    scheduler.cancel(id);
    for (const key of algorithmStates.keys()) if (key.startsWith(`${id}:`)) algorithmStates.delete(key);
    for (const key of lastSignalBars.keys()) if (key.startsWith(`${id}:`)) lastSignalBars.delete(key);
    let endingEquity = null;
    try {
      endingEquity = (await broker.portfolio(current.accountId, { sessionId: current.id, fresh: true, at: clock() })).equity;
    } catch {
      endingEquity = null;
    }
    const completed = await transition(
      id,
      "complete",
      { endedAt: clock(), endingEquity, stopReason: options.reason ?? "user" },
      options.actor ?? "user"
    );
    await finalizePaperMetrics(id, endingEquity);
    return completed;
  }

  async function addRiskEvent(session, options, actionTaken = "session_halted") {
    const persistedAction = {
      session_paused: "logged",
      new_entries_blocked: "logged",
      protective_exit_queued: "logged",
      protective_exit_already_pending: "logged",
      position_exit: "logged"
    }[actionTaken] ?? actionTaken;
    const event = await repositories.risk.addEvent({
      id: idFactory(),
      sessionId: session.id,
      accountId: session.accountId,
      at: clock(),
      ruleId: options.ruleId ?? "manual_halt",
      severity: options.severity ?? "halt",
      actionTaken: persistedAction,
      detail: options.detail == null
        ? { reason: options.reason ?? "user", runtimeAction: actionTaken }
        : { ...options.detail, runtimeAction: actionTaken },
      orderId: options.orderId ?? null
    });
    eventHub?.publish("risk.event", { event });
    await evaluateAlert(
      { type: "risk_event", severity: event.severity, ruleId: event.ruleId, detail: event.detailJson, sessionId: session.id },
      session.id
    );
    return event;
  }

  async function halt(id, options = {}) {
    const current = await repositories.sessions.getById(id);
    if (!current) throw notFound(id);
    let session = current;
    let endingEquity = current.endingEquity;
    if (current.status !== "halted") {
      try {
        endingEquity = (await broker.portfolio(current.accountId, { sessionId: current.id, fresh: true, at: clock() })).equity;
      } catch {
        endingEquity = null;
      }
      session = await transition(
        id,
        "halt",
        { endedAt: clock(), endingEquity, stopReason: options.stopReason ?? (options.ruleId ? "risk_halt" : "user") },
        options.actor ?? (options.ruleId ? "risk_engine" : "user")
      );
      await addRiskEvent(session, options);
    }
    scheduler.cancel(id);
    for (const key of algorithmStates.keys()) if (key.startsWith(`${id}:`)) algorithmStates.delete(key);
    for (const key of lastSignalBars.keys()) if (key.startsWith(`${id}:`)) lastSignalBars.delete(key);
    const liquidation = options.liquidate
      ? await broker.liquidate(session.accountId, {
          sessionId: session.id,
          operationId: options.operationId,
          reason: options.reason ?? "Halt and liquidate"
        })
      : null;
    if (liquidation) {
      await appendAudit("session_liquidation", session, { liquidation }, options.actor ?? "user");
      try {
        endingEquity = (await broker.portfolio(session.accountId, { sessionId: session.id, fresh: true, at: clock() })).equity;
        session = await repositories.sessions.transition(id, "halted", { from: "halted", endingEquity });
      } catch {
        // The halt remains authoritative even if a post-liquidation mark is unavailable.
      }
    }
    if (current.status !== "halted") await finalizePaperMetrics(id, endingEquity);
    return { session, liquidation, idempotent: current.status === "halted" };
  }

  async function haltAll(accountId, options = {}) {
    const results = [];
    const operationId = options.operationId ?? idFactory();
    for (const status of ACTIVE_STATUSES) {
      while (true) {
        const active = await repositories.sessions.list({ accountId, status, limit: 250 });
        if (active.length === 0) break;
        for (const session of active) {
          results.push(await halt(session.id, { ...options, liquidate: false, operationId }));
        }
      }
    }
    const liquidation = options.liquidate
      ? await broker.liquidate(accountId, {
          operationId,
          reason: options.reason ?? "Halt all and liquidate"
        })
      : null;
    return { accountId, halted: results, liquidation };
  }

  async function fillPendingOrders(session, at, { blockEntries } = {}) {
    const pending = await repositories.orders.list({ sessionId: session.id, status: "pending", limit: 250 });
    const results = [];
    const tolerance = nextOpenTolerance(session.barInterval, settleDelayMs);
    const rejectMissedOpen = async (order, detail) => {
      const execution = await ledger.rejectOrder({
        ...order,
        sessionId: session.id,
        accountId: session.accountId,
        rejectReason: "missed_next_bar_open",
        resolvedAt: at
      });
      if (!execution.idempotent) {
        const event = { orderId: order.id, symbol: order.symbol, reason: "missed_next_bar_open", ...detail };
        await addSessionEvent(session, "order_rejected", event);
        await appendAudit("session_order_rejected", session, event, "supervisor");
      }
      results.push(execution);
    };
    for (const order of pending) {
      if (blockEntries && order.side === "buy") {
        const execution = await ledger.rejectOrder({
          ...order,
          sessionId: session.id,
          accountId: session.accountId,
          rejectReason: blockEntries.ruleId,
          resolvedAt: at
        });
        if (!execution.idempotent) {
          const event = {
            orderId: order.id,
            symbol: order.symbol,
            reason: blockEntries.ruleId,
            observed: blockEntries.observed,
            threshold: blockEntries.threshold
          };
          await addSessionEvent(session, "order_rejected", event);
          await appendAudit("session_order_rejected", session, event, "risk_engine");
        }
        results.push(execution);
        continue;
      }
      if (!Number.isSafeInteger(Number(order.signalBarAt))) continue;
      let historical;
      try {
        historical = await market.getBars(order.symbol, rangeForInterval(session.barInterval));
      } catch (error) {
        await appendAudit("session_next_open_unavailable", session, { orderId: order.id, symbol: order.symbol, error: error.message }, "supervisor");
        continue;
      }
      const bars = (historical?.bars ?? [])
        .map((bar) => ({ ...bar, time: typeof bar.time === "number" ? bar.time : Date.parse(bar.time) }))
        .filter((bar) => Number.isSafeInteger(bar.time))
        .sort((left, right) => left.time - right.time);
      const signalIndex = bars.findIndex((bar) => bar.time === Number(order.signalBarAt));
      if (signalIndex < 0) {
        if (bars.some((bar) => bar.time > Number(order.signalBarAt))) {
          await rejectMissedOpen(order, { signalBarAt: order.signalBarAt, detail: "signal_bar_no_longer_available" });
        }
        continue;
      }
      const nextBar = bars[signalIndex + 1];
      if (!nextBar || nextBar.time > at) continue;
      const submittedAt = Number(order.submittedAt);
      const higherEquityInterval = ["1day", "1week", "1month"].includes(session.barInterval) &&
        !isCryptoSymbol(order.symbol);
      const expectedOpenAt = higherEquityInterval ? exchangeBarOpen(nextBar.time) : nextBar.time;
      const maxFillAt = expectedOpenAt + (higherEquityInterval ? tolerance : intervalSpan(session.barInterval, nextBar.time) + tolerance);
      if (expectedOpenAt > at || expectedOpenAt < submittedAt - tolerance || at > maxFillAt) {
        await rejectMissedOpen(order, {
          signalBarAt: order.signalBarAt,
          expectedOpenAt,
          submittedAt,
          observedAt: at
        });
        continue;
      }
      const execution = await broker.submitOrder({
        clientOrderId: order.clientOrderId,
        sessionId: session.id,
        researchSnapshotId: order.researchSnapshotId ?? null,
        accountId: session.accountId,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        signalReason: order.signalReason,
        fillModel: session.fillModelJson,
        referencePrice: nextBar.open,
        riskEngine: createRiskEngine(session.riskProfileJson),
        submittedAt: at,
        filledAt: at
      });
      results.push(execution);
      if (execution.order.status === "filled" && execution.fills.length > 0) {
        const fill = execution.fills[0];
        await addSessionEvent(session, "order_filled", { orderId: order.id, fillId: fill.id, symbol: order.symbol });
        await appendAudit("session_order_filled", session, { orderId: order.id, fillId: fill.id, symbol: order.symbol }, "broker");
        await evaluateAlert({ type: "fill", order: execution.order, fill, symbol: order.symbol }, session.id);
      }
    }
    return results;
  }

  function enginePosition(position, bars) {
    if (!position) return { qty: 0, entryPrice: 0, entryIndex: -1 };
    const openedAt = Math.min(...position.lots.map((lot) => Number(lot.openedAt)));
    let entryIndex = -1;
    for (let index = 0; index < bars.length; index += 1) {
      const time = typeof bars[index].time === "number" ? bars[index].time : Date.parse(bars[index].time);
      if (time <= openedAt) entryIndex = index;
    }
    const entryNumerator = position.lots.reduce(
      (sum, lot) => sum + Number(lot.entryPrice) * Number(lot.qtyOpen),
      0
    );
    return {
      qty: Number(position.qty) / 1_000_000,
      entryPrice: entryNumerator / Number(position.qty) / 100,
      entryIndex
    };
  }

  async function evaluateAndQueueSignals(
    session,
    accountPortfolio,
    at,
    trigger,
    { blockEntries = false, blockedExitSymbols = new Set() } = {}
  ) {
    if (session.status !== "running") return [];
    if (trigger?.kind === "market" && trigger.phase === "open") return [];
    const version = await repositories.algorithms.getVersion(session.algorithmVersionId);
    if (!version) throw new AppError("ALGORITHM_VERSION_NOT_FOUND", "Algorithm version no longer exists.", 404);
    const range = rangeForInterval(session.barInterval);
    const openPositions = new Map(
      (await ledger.listOpenPositions(session.accountId, { sessionId: session.id })).map((position) => [position.symbol, position])
    );
    const riskEngine = createRiskEngine(session.riskProfileJson);
    const research = await sessionResearch(session);
    const queued = [];

    for (const symbol of session.symbolsJson) {
      const gate = scheduleAllows(session.scheduleJson, { now: at, symbol, trigger });
      if (!gate.allowed) {
        eventHub?.publish("session.idle", { sessionId: session.id, symbol, reason: gate.reason });
        continue;
      }
      let historical;
      try {
        historical = await market.getBars(symbol, range);
      } catch (error) {
        await appendAudit("session_bars_unavailable", session, { symbol, error: error.message }, "supervisor");
        continue;
      }
      const bars = realClosedBars(historical, session.barInterval, at, symbol, trigger);
      if (bars.length === 0) {
        await appendAudit("session_bars_unavailable", session, { symbol, reason: "no_closed_real_bars" }, "supervisor");
        continue;
      }
      const position = openPositions.get(symbol);
      const stateKey = `${session.id}:${symbol}`;
      const latestBarAt = barTime(bars.at(-1));
      if (lastSignalBars.get(stateKey) === latestBarAt) continue;
      const researchFrame = await researchFrameAt(research, symbol, latestBarAt);
      if (research?.required && researchFrame?.status !== "available") {
        lastSignalBars.set(stateKey, latestBarAt);
        const detail = {
          symbol,
          barTime: latestBarAt,
          researchPlanVersionId: research.version.id,
          reason: researchFrame?.reason ?? "no_eligible_snapshot"
        };
        await addSessionEvent(session, "research_unavailable", detail);
        await appendAudit("session_research_unavailable", session, detail, "engine");
        eventHub?.publish("session.idle", { sessionId: session.id, ...detail });
        continue;
      }
      const evaluated = await enginePool.evaluateSignal({
        algorithmSource: version.sourceCode,
        filename: `${version.algorithmId}.js`,
        bars,
        params: session.paramsJson,
        position: enginePosition(position, bars),
        state: algorithmStates.get(stateKey),
        research: researchFrame
      });
      algorithmStates.set(stateKey, evaluated.state);
      lastSignalBars.set(stateKey, latestBarAt);
      const signal = evaluated.signal;
      if (!signal || (signal.action === "buy" && position) || (signal.action === "sell" && !position)) continue;
      if (signal.action === "buy" && blockEntries) continue;
      if (signal.action === "sell" && blockedExitSymbols.has(symbol)) continue;

      const markedPosition = accountPortfolio.positions.find((item) => item.symbol === symbol);
      const sizing = signal.action === "buy"
        ? riskEngine.sizeOrder({
            signal: "buy",
            price: evaluated.close,
            equity: Number(accountPortfolio.equity) / 100,
            cash: Number(accountPortfolio.buyingPower ?? accountPortfolio.cash) / 100,
            atr: evaluated.atr,
            currentNotional: Number(markedPosition?.marketValue ?? 0) / 100
          })
        : { qty: Number(position.qty) / 1_000_000, mode: "close_position" };
      const qty = Math.max(0, Math.round(Number(sizing.qty) * 1_000_000));
      if (qty === 0) continue;
      const clientOrderId = `paper:${session.id}:${symbol}:${evaluated.barTime}:${signal.action}`;
      const execution = await broker.queueOrder({
        clientOrderId,
        sessionId: session.id,
        researchSnapshotId: researchFrame?.status === "available" ? researchFrame.snapshot.id : null,
        accountId: session.accountId,
        symbol,
        side: signal.action,
        qty,
        signalReason: signal.reason ?? `Algorithm ${signal.action} signal`,
        signalBarAt: evaluated.barTime,
        submittedAt: at
      });
      if (!execution.idempotent) {
        const event = {
          type: "signal",
          action: signal.action,
          symbol,
          confidence: signal.confidence,
          barTime: evaluated.barTime,
          orderId: execution.order.id,
          researchSnapshotId: execution.order.researchSnapshotId ?? null,
          sizing
        };
        await addSessionEvent(session, "signal", event);
        await appendAudit("session_signal", session, event, "engine");
        await evaluateAlert(event, session.id);
      }
      queued.push({
        symbol,
        signal,
        sizing,
        research: researchFrame,
        order: execution.order,
        idempotent: execution.idempotent
      });
    }
    return queued;
  }

  async function continuousRiskState(session, portfolio, at) {
    const [history, accountPortfolio, accountPeakRows] = await Promise.all([
      repositories.sessions.getEquity(session.id, { limit: 50_000 }),
      broker.portfolio(session.accountId, { fresh: true, at, rememberQuotes: false }),
      client.query(
        `SELECT MAX(equity_snapshots.equity) AS peak
         FROM equity_snapshots
         JOIN sessions ON sessions.id = equity_snapshots.session_id
         WHERE sessions.account_id = ?`,
        [session.accountId]
      )
    ]);
    const peak = Math.max(
      Number(session.startingEquity),
      ...history.map((point) => Number(point.equity)),
      Number(portfolio.equity)
    );
    const accountEquity = Number(accountPortfolio.equity ?? portfolio.equity);
    const accountPeakEquity = Math.max(accountEquity, Number(accountPeakRows[0]?.peak ?? 0));
    const quoteTimes = portfolio.positions
      .filter((position) => position.dataStatus === "real" && Number.isFinite(Number(position.quoteAt)))
      .map((position) => Number(position.quoteAt));
    const latestQuoteAt = quoteTimes.length > 0 ? Math.min(...quoteTimes) : at;
    const failures = createRiskEngine(session.riskProfileJson).continuous({
      now: at,
      startingEquity: Number(session.startingEquity) / 100,
      dayStartEquity: Number(portfolio.dayStartEquity ?? session.startingEquity) / 100,
      equity: Number(portfolio.equity) / 100,
      peakEquity: peak / 100,
      accountPeakEquity: accountPeakEquity / 100,
      accountEquity: accountEquity / 100,
      positionValue: Number(portfolio.positionValue ?? 0) / 100,
      latestQuoteAt
    });
    return { history, peak, accountPeakEquity, accountPortfolio, failures };
  }

  async function queueProtectiveExits(session, portfolio, at, trigger) {
    const positions = await ledger.listOpenPositions(session.accountId, { sessionId: session.id });
    if (positions.length === 0) return [];
    const marks = new Map(portfolio.positions.map((position) => [position.symbol, position]));
    const candidates = createRiskEngine(session.riskProfileJson).protectiveExits({
      positions: positions.map((position) => ({
        symbol: position.symbol,
        price: Number(marks.get(position.symbol)?.price ?? 0) / 100,
        lots: position.lots.map((lot) => ({
          id: lot.id,
          entryPrice: Number(lot.entryPrice) / 100,
          qty: Number(lot.qtyOpen)
        }))
      }))
    });
    if (candidates.length === 0) return [];
    const pending = await repositories.orders.list({ sessionId: session.id, status: "pending", limit: 250 });
    const queued = [];
    for (const candidate of candidates) {
      const alreadyPending = pending
        .filter((order) => order.symbol === candidate.symbol && order.side === "sell")
        .reduce((sum, order) => sum + Number(order.qty), 0);
      const qty = Math.max(0, Number(candidate.qty) - alreadyPending);
      let signalBarAt = null;
      if (qty > 0) {
        try {
          const historical = await market.getBars(candidate.symbol, rangeForInterval(session.barInterval));
          const closed = realClosedBars(
            historical,
            session.barInterval,
            at,
            candidate.symbol,
            trigger
          );
          signalBarAt = closed.length > 0 ? barTime(closed.at(-1)) : null;
        } catch (error) {
          await appendAudit("session_protective_exit_unavailable", session, {
            symbol: candidate.symbol,
            ruleId: candidate.ruleId,
            error: error.message
          }, "risk_engine");
          continue;
        }
      }
      if (qty > 0 && !Number.isSafeInteger(signalBarAt)) {
        await appendAudit("session_protective_exit_unavailable", session, {
          symbol: candidate.symbol,
          ruleId: candidate.ruleId,
          reason: "no_closed_real_bars"
        }, "risk_engine");
        continue;
      }
      const lotHash = createHash("sha256")
        .update(candidate.lotIds.slice().sort().join("|"))
        .digest("hex")
        .slice(0, 16);
      const execution = qty > 0
        ? await broker.queueOrder({
            clientOrderId: `risk:${session.id}:${candidate.ruleId}:${candidate.symbol}:${lotHash}`,
            sessionId: session.id,
            accountId: session.accountId,
            symbol: candidate.symbol,
            side: "sell",
            qty,
            signalReason: `${candidate.ruleId}: ${candidate.message}`,
            signalBarAt,
            submittedAt: at
          })
        : { order: pending.find((order) => order.symbol === candidate.symbol && order.side === "sell"), idempotent: true };
      if (!execution.order) continue;
      const [attributed] = await client.query(
        "SELECT id FROM risk_events WHERE session_id = ? AND rule_id = ? AND order_id = ? LIMIT 1",
        [session.id, candidate.ruleId, execution.order.id]
      );
      if (!attributed) {
        const detail = {
          ...candidate,
          orderId: execution.order.id,
          queuedQty: qty,
          coveredByPendingQty: Math.min(alreadyPending, Number(candidate.qty))
        };
        await addRiskEvent(session, { ...candidate, orderId: execution.order.id, detail }, qty > 0 ? "protective_exit_queued" : "protective_exit_already_pending");
        await addSessionEvent(session, "protective_exit", detail);
        await appendAudit("session_protective_exit", session, detail, "risk_engine");
      }
      queued.push({ ...candidate, qty, order: execution.order, idempotent: execution.idempotent });
    }
    return queued;
  }

  async function tick(id, trigger) {
    const session = await repositories.sessions.getById(id);
    if (!session || (session.status !== "running" && session.status !== "paused")) return null;
    const at = clock();
    if (session.scheduleJson?.type === "fixed_window" && at >= Number(session.scheduleJson.endAt)) {
      return { session: await stop(id, { reason: "schedule", actor: "scheduler" }), portfolio: null, failures: [], fills: [], signals: [], protectiveExits: [] };
    }
    let portfolio = await broker.portfolio(session.accountId, {
      sessionId: session.id,
      fresh: true,
      at,
      rememberQuotes: false
    });
    if (portfolio.equity === null) {
      if (session.status === "running") {
        await transition(id, "pause", {}, "risk_engine");
      }
      const failure = {
        triggered: true,
        ruleId: "data_staleness",
        severity: "warn",
        action: "session_paused",
        message: "Real marks are unavailable; session paused before order processing.",
        observed: portfolio.dataStatus,
        threshold: "real"
      };
      await addRiskEvent(session, { ...failure, detail: failure }, failure.action);
      await appendAudit("session_data_stale", session, { dataStatus: portfolio.dataStatus }, "risk_engine");
      return {
        session: await repositories.sessions.getById(id),
        portfolio,
        failures: [failure],
        fills: [],
        signals: [],
        protectiveExits: []
      };
    }
    const riskState = await continuousRiskState(session, portfolio, at);
    await repositories.sessions.addEquitySnapshot({
      sessionId: id,
      at,
      equity: portfolio.equity,
      cash: portfolio.cash,
      positionValue: portfolio.positionValue ?? 0,
      drawdownPercent: riskState.peak > 0 ? ((riskState.peak - portfolio.equity) / riskState.peak) * 100 : 0
    });
    const failures = riskState.failures;
    const halting = failures.find((failure) => failure.severity === "halt");
    for (const failure of failures) {
      if (failure !== halting) await addRiskEvent(session, { ...failure, detail: failure }, failure.action ?? "logged");
    }
    if (halting) {
      if (halting.ruleId === "max_account_drawdown") return haltAll(session.accountId, { ...halting, actor: "risk_engine" });
      return halt(id, { ...halting, actor: "risk_engine" });
    }
    const stale = failures.find((failure) => failure.action === "session_paused");
    if (stale && session.status === "running") {
      await transition(id, "pause", {}, "risk_engine");
    }
    if (stale) {
      return {
        session: await repositories.sessions.getById(id),
        portfolio,
        failures,
        fills: [],
        signals: [],
        protectiveExits: []
      };
    }
    const entryBlock = failures.find((failure) => failure.action === "new_entries_blocked");
    const fills = await fillPendingOrders(session, at, { blockEntries: entryBlock });
    portfolio = await broker.portfolio(session.accountId, { sessionId: session.id, fresh: true, at });
    if (portfolio.equity === null) {
      if (session.status === "running") await transition(id, "pause", {}, "risk_engine");
      await appendAudit("session_data_stale", session, { dataStatus: portfolio.dataStatus, phase: "post_fill" }, "risk_engine");
      return {
        session: await repositories.sessions.getById(id),
        portfolio,
        failures,
        fills,
        signals: [],
        protectiveExits: []
      };
    }
    const postFillPeak = Math.max(riskState.peak, Number(portfolio.equity));
    await repositories.sessions.addEquitySnapshot({
      sessionId: id,
      at,
      equity: portfolio.equity,
      cash: portfolio.cash,
      positionValue: portfolio.positionValue ?? 0,
      drawdownPercent: postFillPeak > 0 ? ((postFillPeak - portfolio.equity) / postFillPeak) * 100 : 0
    });
    const protectiveExits = await queueProtectiveExits(session, portfolio, at, trigger);
    const refreshed = await repositories.sessions.getById(id);
    let signals;
    try {
      signals = await evaluateAndQueueSignals(refreshed, portfolio, at, trigger, {
        blockEntries: Boolean(entryBlock),
        blockedExitSymbols: new Set(protectiveExits.map((exit) => exit.symbol))
      });
    } catch (error) {
      await fail(id, error);
      throw error;
    }
    eventHub?.publish("session.tick", { sessionId: id, portfolio, failures, fills, signals, protectiveExits, trigger });
    return {
      session: await repositories.sessions.getById(id),
      portfolio,
      failures,
      fills,
      signals,
      protectiveExits
    };
  }

  async function bootstrap(options = {}) {
    const account = await broker.ensureDefaultAccount(options.account);
    const recovered = [];
    const markRestartError = async (session, status) => {
      const error = new Error(`Session was ${status} when the server restarted.`);
      const failed = await repositories.sessions.transition(session.id, "errored", {
        from: status,
        endedAt: clock(),
        stopReason: "error",
        errorDetail: error.message
      });
      if (failed) {
        await addSessionEvent(failed, "state_transition", { reason: "server_restart" }, status, "errored");
        await appendAudit("session_restart_error", failed, { previousStatus: status }, "supervisor");
        await evaluateAlert({ type: "session_state", status: "errored", previousStatus: status, sessionId: failed.id }, failed.id);
        recovered.push(failed);
      }
    };
    for (const status of ACTIVE_STATUSES) {
      if (status === "running" && restartRunningSessions) {
        const sessions = await repositories.sessions.list({ status, limit: 250 });
        for (const session of sessions) {
          try {
            await preflight(session);
            armScheduler(session);
            await appendAudit("session_restart_resumed", session, { previousStatus: status }, "supervisor");
            recovered.push(session);
          } catch {
            await markRestartError(session, status);
          }
        }
        continue;
      }
      while (true) {
        const sessions = await repositories.sessions.list({ status, limit: 250 });
        if (sessions.length === 0) break;
        for (const session of sessions) await markRestartError(session, status);
      }
    }
    return { account, recovered };
  }

  async function close() {
    scheduler.cancelAll();
  }

  return Object.freeze({
    bootstrap,
    create,
    list,
    get,
    getEquity,
    getOrders,
    getEvents,
    compare,
    exportData,
    start,
    pause,
    resume,
    stop,
    halt,
    haltAll,
    tick,
    close
  });
}
