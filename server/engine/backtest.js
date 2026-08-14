import { createHash } from "node:crypto";
import { createIndicators } from "./indicators.js";
import { affordableQuantity, calculateFill, normalizeFillModel } from "./fill-model.js";
import { computeMetrics } from "./metrics.js";
import {
  normalizeResearchTimeline,
  researchTimelineHash as hashResearchTimeline,
  selectResearchFrame
} from "../research/timeline.js";

function round(value, precision = 10) {
  return Number(value.toFixed(precision));
}

function cloneAndFreeze(value) {
  if (value === undefined) return undefined;
  const cloned = structuredClone(value);
  const freeze = (item) => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return item;
    for (const child of Object.values(item)) freeze(child);
    return Object.freeze(item);
  };
  return freeze(cloned);
}

function normalizeBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new TypeError("bars must contain at least one OHLCV bar.");
  }

  let previousTime = -Infinity;
  return Object.freeze(
    bars.map((input, index) => {
      const open = Number(input.open);
      const high = Number(input.high);
      const low = Number(input.low);
      const close = Number(input.close);
      const volume = Number(input.volume ?? 0);
      if (![open, high, low, close, volume].every(Number.isFinite) || open <= 0 || close <= 0 || volume < 0) {
        throw new TypeError(`Bar ${index} contains invalid OHLCV values.`);
      }
      if (high < Math.max(open, close) || low > Math.min(open, close) || low < 0) {
        throw new TypeError(`Bar ${index} has an invalid high/low range.`);
      }
      const parsedTime = typeof input.time === "number" ? input.time : Date.parse(input.time);
      if (!Number.isSafeInteger(parsedTime) || parsedTime < 0) {
        throw new TypeError(`Bar ${index} has an invalid epoch-ms time.`);
      }
      if (parsedTime < previousTime) {
        throw new TypeError("bars must be ordered by ascending time.");
      }
      previousTime = parsedTime;
      return Object.freeze({ time: parsedTime, open, high, low, close, volume });
    })
  );
}

function normalizeSignal(rawSignal) {
  if (rawSignal === null || rawSignal === undefined) return null;
  if (rawSignal && typeof rawSignal.then === "function") {
    throw new TypeError("Algorithm signal() must be synchronous.");
  }
  if (rawSignal === "buy" || rawSignal === "sell") {
    return Object.freeze({ action: rawSignal });
  }
  if (typeof rawSignal === "object" && (rawSignal.action === "buy" || rawSignal.action === "sell")) {
    return Object.freeze({
      action: rawSignal.action,
      reason: typeof rawSignal.reason === "string" ? rawSignal.reason : undefined,
      confidence: Number.isFinite(Number(rawSignal.confidence)) ? Number(rawSignal.confidence) : undefined
    });
  }
  throw new TypeError('Algorithm signal() must return "buy", "sell", a structured signal, or null.');
}

function actionable(signal, quantity) {
  return signal?.action === "buy" ? quantity === 0 : signal?.action === "sell" && quantity > 0;
}

/**
 * Pure deterministic backtest. A signal from bar i becomes a pending market
 * order and can only fill at bar i+1 open. The final bar can signal, but that
 * signal is returned as `unfilledSignal` rather than fabricated into a fill.
 */
export function runBacktest({
  bars: inputBars,
  algorithm,
  params: parameterOverrides,
  startingCash = 100_000,
  positionFraction = 0.95,
  fillModel: fillModelInput,
  interval = "1day",
  assetClass = "equity",
  windowStart,
  windowEnd,
  barsHash,
  researchTimeline: researchTimelineInput = [],
  symbol,
  researchRequired = false
}) {
  if (!algorithm || typeof algorithm !== "object" || typeof algorithm.signal !== "function") {
    throw new TypeError("algorithm must be an object with a signal() function.");
  }
  if (!Number.isFinite(startingCash) || startingCash <= 0) {
    throw new TypeError("startingCash must be positive and finite.");
  }
  if (!Number.isFinite(positionFraction) || positionFraction <= 0 || positionFraction > 1) {
    throw new TypeError("positionFraction must be greater than zero and at most one.");
  }

  const normalizedBars = normalizeBars(inputBars);
  const requestedWindowStart = windowStart == null ? null : Number(windowStart);
  const requestedWindowEnd = windowEnd == null ? null : Number(windowEnd);
  if ((requestedWindowStart !== null && !Number.isSafeInteger(requestedWindowStart)) ||
      (requestedWindowEnd !== null && !Number.isSafeInteger(requestedWindowEnd)) ||
      (requestedWindowStart !== null && requestedWindowEnd !== null && requestedWindowEnd < requestedWindowStart)) {
    throw new TypeError("Backtest windowStart/windowEnd must be ordered epoch-ms integers.");
  }
  const bars = Object.freeze(normalizedBars.filter((bar) =>
    (requestedWindowStart === null || bar.time >= requestedWindowStart) &&
    (requestedWindowEnd === null || bar.time <= requestedWindowEnd)
  ));
  if (bars.length === 0) throw new RangeError("The requested backtest window contains no bars.");
  const computedBarsHash = createHash("sha256").update(JSON.stringify(bars)).digest("hex");
  if (barsHash !== undefined && barsHash !== computedBarsHash) {
    throw new TypeError("barsHash does not match the supplied backtest window.");
  }
  const researchTimeline = normalizeResearchTimeline(researchTimelineInput);
  const researchSymbol = symbol == null ? null : String(symbol).trim().toUpperCase();
  if (typeof researchRequired !== "boolean") {
    throw new TypeError("researchRequired must be a boolean.");
  }
  if ((researchTimeline.length > 0 || researchRequired) && !researchSymbol) {
    throw new TypeError("symbol is required when research is configured for a backtest.");
  }
  const computedResearchTimelineHash = hashResearchTimeline(researchTimeline);
  const indicatorSet = createIndicators(bars);
  const fillModel = normalizeFillModel(fillModelInput);
  const params = cloneAndFreeze({ ...(algorithm.params ?? {}), ...(parameterOverrides ?? {}) });
  const emptyBars = Object.freeze([]);
  const emptyCloses = Object.freeze([]);
  let state = {};
  if (typeof algorithm.init === "function") {
    state = algorithm.init({
      bars: emptyBars,
      closes: emptyCloses,
      params,
      indicators: indicatorSet.at(-1),
      research: null
    }) ?? {};
  }

  let cash = startingCash;
  let quantity = 0;
  let entryPrice = 0;
  let entryIndex = -1;
  let entryCost = 0;
  let pendingSignal = null;
  let lastSignal = null;
  let lastSignalDetail = null;
  let barsInPosition = 0;
  let fillSequence = 0;
  const trades = [];
  const equityCurve = [
    Object.freeze({ time: bars[0].time, equity: startingCash, cash: startingCash, positionValue: 0 })
  ];

  const recordFill = (pending, fillIndex) => {
    const bar = bars[fillIndex];
    if (pending.action === "buy") {
      const budget = cash * positionFraction;
      const nextQuantity = affordableQuantity({ cashBudget: budget, referencePrice: bar.open }, fillModel);
      if (nextQuantity <= 0) throw new RangeError("Fill model commissions leave no affordable buy quantity.");
      const fill = calculateFill(
        { side: "buy", quantity: nextQuantity, referencePrice: bar.open },
        fillModel
      );
      cash = round(cash + fill.cashDelta);
      quantity = nextQuantity;
      entryPrice = fill.price;
      entryIndex = fillIndex;
      entryCost = fill.grossNotional + fill.commission;
      fillSequence += 1;
      trades.push(
        Object.freeze({
          id: `fill-${String(fillSequence).padStart(4, "0")}`,
          signalIndex: pending.signalIndex,
          fillIndex,
          signalTime: pending.signalTime,
          time: bar.time,
          side: "buy",
          ...fill,
          notional: fill.grossNotional,
          rule: pending.reason ?? `${algorithm.name ?? "Algorithm"} entry signal`,
          confidence: pending.confidence,
          researchSnapshotId: pending.researchSnapshotId ?? null,
          realizedPnl: 0,
          pnlPercent: 0
        })
      );
      return;
    }

    const fill = calculateFill({ side: "sell", quantity, referencePrice: bar.open }, fillModel);
    const realizedPnl = round(fill.grossNotional - fill.commission - entryCost);
    const pnlPercent = entryCost > 0 ? round((realizedPnl / entryCost) * 100, 6) : 0;
    cash = round(cash + fill.cashDelta);
    fillSequence += 1;
    trades.push(
      Object.freeze({
        id: `fill-${String(fillSequence).padStart(4, "0")}`,
        signalIndex: pending.signalIndex,
        fillIndex,
        signalTime: pending.signalTime,
        time: bar.time,
        side: "sell",
        ...fill,
        notional: fill.grossNotional,
        rule: pending.reason ?? `${algorithm.name ?? "Algorithm"} exit signal`,
        confidence: pending.confidence,
        researchSnapshotId: pending.researchSnapshotId ?? null,
        realizedPnl,
        pnlPercent
      })
    );
    quantity = 0;
    entryPrice = 0;
    entryIndex = -1;
    entryCost = 0;
  };

  for (let index = 1; index < bars.length; index += 1) {
    if (pendingSignal) {
      recordFill(pendingSignal, index);
      pendingSignal = null;
    }

    const boundedBars = Object.freeze(bars.slice(0, index + 1));
    const boundedCloses = Object.freeze(indicatorSet.closes.slice(0, index + 1));
    const research = researchSymbol
      ? selectResearchFrame({ timeline: researchTimeline, symbol: researchSymbol, decisionAt: bars[index].time })
      : null;
    const signal = researchRequired && research?.status !== "available"
      ? null
      : normalizeSignal(
          algorithm.signal({
            index,
            bar: bars[index],
            bars: boundedBars,
            closes: boundedCloses,
            state,
            params,
            indicators: indicatorSet.at(index),
            position: Object.freeze({ qty: quantity, entryPrice, entryIndex }),
            research
          })
        );

    if (index === bars.length - 1) {
      lastSignal = signal?.action ?? null;
      lastSignalDetail = signal;
    }
    if (actionable(signal, quantity)) {
      const candidate = Object.freeze({
        ...signal,
        signalIndex: index,
        signalTime: bars[index].time,
        researchSnapshotId: research?.status === "available" ? research.snapshot.id : null
      });
      if (index < bars.length - 1) pendingSignal = candidate;
      else pendingSignal = candidate;
    }

    if (quantity > 0) barsInPosition += 1;
    const positionValue = round(quantity * bars[index].close);
    equityCurve.push(
      Object.freeze({
        time: bars[index].time,
        equity: round(cash + positionValue),
        cash: round(cash),
        positionValue
      })
    );
  }

  const unfilledSignal = pendingSignal;
  const metrics = computeMetrics({
    equityCurve,
    trades,
    startingEquity: startingCash,
    interval,
    assetClass,
    barsInPosition,
    totalBars: Math.max(bars.length - 1, 0),
    openPosition: quantity > 0
  });

  return Object.freeze({
    trades: Object.freeze(trades),
    fills: Object.freeze(trades),
    equityCurve: Object.freeze(equityCurve),
    lastSignal,
    lastSignalDetail,
    unfilledSignal,
    researchTimelineHash: computedResearchTimelineHash,
    metrics,
    endingState: Object.freeze({
      cash: round(cash),
      position: Object.freeze({ qty: quantity, entryPrice, entryIndex })
    }),
    config: Object.freeze({
      startingCash,
      positionFraction,
      interval,
      assetClass,
      fillModel,
      windowStart: requestedWindowStart ?? bars[0].time,
      windowEnd: requestedWindowEnd ?? bars.at(-1).time,
      barsHash: computedBarsHash,
      researchTimelineHash: computedResearchTimelineHash,
      researchRequired
    })
  });
}

export function runAlgorithmBacktest(bars, algorithm, options = {}) {
  return runBacktest({ bars, algorithm, ...options });
}
