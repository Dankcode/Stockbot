/**
 * Walk-forward backtest of the momentum rotation.
 *
 * The sequence matches the rest of Stockbot:
 *
 *   bar N closes → rank on data through N → orders pending → bar N+1 opens → fill
 *
 * - Ranking at bar N sees each symbol's history through N only.
 * - Fills use bar N+1's real open through the shared fill model (slippage and
 *   commission). A rebalance decided on the final bar is reported as unfilled.
 * - A per-position trailing stop is checked on closes and exits at the next open.
 * - Results are compared with SPY buy-and-hold and Cash over the same bars.
 */
import { calculateFill, normalizeFillModel } from "../engine/fill-model.js";
import { computeMetrics } from "../engine/metrics.js";
import { ROTATION_MIN_BARS, normalizeRotationConfig, rankRotation } from "./rotation.js";

export const DEFAULT_ROTATION_BACKTEST = Object.freeze({
  startingEquity: 100_000,
  rebalanceEvery: 5,
  trailingStop: 0.15,
  rebalanceBand: 0.02,
  fillModel: Object.freeze({ slippageBps: 5, fixedCommission: 0, perShareCommission: 0, quantityPrecision: 6 })
});

const dayKey = (time) => new Date(Number(time)).toISOString().slice(0, 10);
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));

function alignBars(barsBySymbol, benchmark) {
  const timeline = (barsBySymbol[benchmark] ?? []).map((bar) => dayKey(bar.time));
  if (timeline.length === 0) throw new TypeError(`Rotation backtest requires ${benchmark} bars as its calendar.`);
  // For each symbol and each calendar day: the index of its last bar on or before that day,
  // and whether it printed a bar that day (only such days can fill).
  const lastIndex = {};
  const sameDay = {};
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const keys = bars.map((bar) => dayKey(bar.time));
    const last = new Array(timeline.length).fill(-1);
    const today = new Array(timeline.length).fill(-1);
    let cursor = -1;
    for (let day = 0; day < timeline.length; day += 1) {
      while (cursor + 1 < keys.length && keys[cursor + 1] <= timeline[day]) cursor += 1;
      last[day] = cursor;
      if (cursor >= 0 && keys[cursor] === timeline[day]) today[day] = cursor;
    }
    lastIndex[symbol] = last;
    sameDay[symbol] = today;
  }
  return { timeline, lastIndex, sameDay };
}

export function runRotationBacktest(barsBySymbol, options = {}) {
  const config = normalizeRotationConfig(options.rotation ?? {});
  const settings = { ...DEFAULT_ROTATION_BACKTEST, ...Object.fromEntries(Object.entries(options).filter(([key, value]) => key !== "rotation" && value !== undefined)) };
  const fillModel = normalizeFillModel(settings.fillModel);
  const rebalanceEvery = Math.max(1, Math.trunc(Number(settings.rebalanceEvery)));
  const trailingStop = Math.max(0, Math.min(0.9, Number(settings.trailingStop)));
  const benchmark = config.benchmark;
  const benchBars = barsBySymbol[benchmark];
  const { timeline, lastIndex, sameDay } = alignBars(barsBySymbol, benchmark);
  const warmup = ROTATION_MIN_BARS - 1;
  if (timeline.length <= warmup + 1) {
    throw new RangeError(`Rotation backtest needs more than ${warmup + 1} ${benchmark} daily bars; received ${timeline.length}.`);
  }

  let cash = Number(settings.startingEquity);
  const positions = new Map(); // symbol -> { quantity, cost, entryTime, highClose }
  const trades = [];
  const rebalances = [];
  const equityCurve = [];
  let pending = null; // { targets, reason, decidedAt } or { stops: [symbol] }
  let barsInPosition = 0;
  let unfilledRebalance = null;

  const barAt = (symbol, day, mode) => {
    const index = (mode === "same" ? sameDay : lastIndex)[symbol]?.[day] ?? -1;
    return index >= 0 ? barsBySymbol[symbol][index] : null;
  };
  const markToMarket = (day, field) => {
    let value = cash;
    for (const [symbol, position] of positions) {
      const bar = barAt(symbol, day, "last");
      value += position.quantity * Number(bar?.[field] ?? bar?.close ?? 0);
    }
    return value;
  };
  const sell = (symbol, quantity, bar, day, reason) => {
    const position = positions.get(symbol);
    if (!position || quantity <= 0) return;
    const fill = calculateFill({ side: "sell", quantity, referencePrice: Number(bar.open) }, fillModel);
    const costBasis = position.cost * (quantity / position.quantity);
    cash += fill.cashDelta;
    const realizedPnl = fill.cashDelta - costBasis;
    trades.push({ time: Number(bar.time), symbol, side: "sell", quantity: round(quantity), price: fill.price, notional: round(fill.grossNotional, 2), reason, realizedPnl: round(realizedPnl, 2), pnlPercent: round(costBasis > 0 ? (realizedPnl / costBasis) * 100 : 0, 4) });
    if (quantity >= position.quantity - 1e-9) positions.delete(symbol);
    else positions.set(symbol, { ...position, quantity: position.quantity - quantity, cost: position.cost - costBasis });
  };
  const buy = (symbol, quantity, bar, reason) => {
    if (quantity <= 0) return;
    const fill = calculateFill({ side: "buy", quantity, referencePrice: Number(bar.open) }, fillModel);
    if (-fill.cashDelta > cash + 1e-6) return;
    cash += fill.cashDelta;
    const position = positions.get(symbol);
    positions.set(symbol, position
      ? { ...position, quantity: position.quantity + quantity, cost: position.cost - fill.cashDelta }
      : { quantity, cost: -fill.cashDelta, entryTime: Number(bar.time), highClose: Number(bar.open) });
    trades.push({ time: Number(bar.time), symbol, side: "buy", quantity: round(quantity), price: fill.price, notional: round(fill.grossNotional, 2), reason, realizedPnl: null, pnlPercent: null });
  };

  for (let day = warmup; day < timeline.length; day += 1) {
    // 1. Fill what was decided at the previous close, at this bar's open.
    if (pending) {
      for (const symbol of pending.stops ?? []) {
        const bar = barAt(symbol, day, "same");
        if (bar && positions.has(symbol)) sell(symbol, positions.get(symbol).quantity, bar, day, "trailing_stop");
      }
      if (pending.targets) {
        const targets = pending.targets;
        for (const symbol of [...positions.keys()]) {
          const bar = barAt(symbol, day, "same");
          if (!(symbol in targets) && bar) sell(symbol, positions.get(symbol).quantity, bar, day, "rotation_out");
        }
        const equityAtOpen = markToMarket(day, "open");
        for (const [symbol, weight] of Object.entries(targets)) {
          const bar = barAt(symbol, day, "same");
          if (!bar || !(Number(bar.open) > 0)) continue;
          const held = positions.get(symbol)?.quantity ?? 0;
          const currentValue = held * Number(bar.open);
          const delta = weight * equityAtOpen - currentValue;
          if (held > 0 && Math.abs(delta) < settings.rebalanceBand * equityAtOpen) continue;
          const quantity = Number((Math.abs(delta) / Number(bar.open)).toFixed(fillModel.quantityPrecision));
          if (delta < 0) sell(symbol, Math.min(quantity, held), bar, day, "rebalance");
          else if (delta > 0) {
            const affordable = Math.min(quantity, Number(((cash / (Number(bar.open) * (1 + fillModel.slippageBps / 10_000))) * 0.9999).toFixed(fillModel.quantityPrecision)));
            buy(symbol, affordable, bar, held > 0 ? "rebalance" : "rotation_in");
          }
        }
      }
      pending = null;
    }

    // 2. Mark at the close and check trailing stops.
    const stops = [];
    for (const [symbol, position] of positions) {
      const bar = barAt(symbol, day, "same");
      if (!bar) continue;
      position.highClose = Math.max(position.highClose, Number(bar.close));
      if (trailingStop > 0 && Number(bar.close) < position.highClose * (1 - trailingStop)) stops.push(symbol);
    }
    if (positions.size > 0) barsInPosition += 1;
    equityCurve.push({ time: Number(benchBars[day].time), equity: round(markToMarket(day, "close"), 2) });

    // 3. Decide at the close. Ranking sees each symbol's bars through this day only.
    const due = (day - warmup) % rebalanceEvery === 0;
    if (due) {
      const endIndexBySymbol = Object.fromEntries(Object.keys(barsBySymbol).map((symbol) => [symbol, lastIndex[symbol][day]]));
      const visible = Object.fromEntries(Object.entries(barsBySymbol).filter(([symbol]) => endIndexBySymbol[symbol] >= 0));
      const ranked = rankRotation(visible, config, endIndexBySymbol);
      const decision = { time: Number(benchBars[day].time), riskOn: ranked.regime.riskOn, selected: ranked.selected, targets: ranked.targets };
      rebalances.push(decision);
      // A stopped-out name sits out until the next rebalance: drop it from these
      // targets so it is sold (rotation_out), not sold and immediately bought back.
      const targets = Object.fromEntries(Object.entries(ranked.targets).filter(([symbol]) => !stops.includes(symbol)));
      decision.stopped = stops;
      if (day === timeline.length - 1) unfilledRebalance = decision;
      else pending = { targets };
    } else if (stops.length > 0 && day < timeline.length - 1) {
      pending = { stops };
    }
  }

  // SPY buy-and-hold control: same first fill bar, same fill model.
  const firstFillDay = warmup + 1;
  const firstBench = benchBars[firstFillDay];
  const benchFill = calculateFill({ side: "buy", quantity: 1, referencePrice: Number(firstBench.open) }, fillModel);
  const benchShares = Number(settings.startingEquity) / -benchFill.cashDelta;
  const benchmarkCurve = equityCurve.map((point, index) => ({
    time: point.time,
    equity: index === 0 ? Number(settings.startingEquity) : round(benchShares * Number(benchBars[warmup + index].close), 2)
  }));
  const cashCurve = equityCurve.map((point) => ({ time: point.time, equity: Number(settings.startingEquity) }));
  let peak = -Infinity;
  const drawdown = equityCurve.map((point) => {
    peak = Math.max(peak, point.equity);
    return { time: point.time, value: round(point.equity / peak - 1) };
  });

  const strategyMetrics = computeMetrics({ equityCurve, trades, startingEquity: settings.startingEquity, interval: "1day", barsInPosition, totalBars: equityCurve.length - 1, openPosition: positions.size > 0 });
  const benchmarkMetrics = computeMetrics({ equityCurve: benchmarkCurve, trades: [], startingEquity: settings.startingEquity, interval: "1day", barsInPosition: benchmarkCurve.length - 1, totalBars: benchmarkCurve.length - 1, openPosition: true });

  return Object.freeze({
    start: equityCurve[0].time,
    end: equityCurve.at(-1).time,
    settings: Object.freeze({ startingEquity: settings.startingEquity, rebalanceEvery, trailingStop, rebalanceBand: settings.rebalanceBand, fillModel }),
    config,
    metrics: Object.freeze({ strategy: strategyMetrics, [benchmark]: benchmarkMetrics, cash: computeMetrics({ equityCurve: cashCurve, trades: [], startingEquity: settings.startingEquity, interval: "1day" }) }),
    equityCurve: Object.freeze(equityCurve),
    benchmarkCurve: Object.freeze(benchmarkCurve),
    drawdown: Object.freeze(drawdown),
    trades: Object.freeze(trades),
    rebalances: Object.freeze(rebalances),
    unfilledRebalance,
    openPositions: Object.freeze([...positions.entries()].map(([symbol, position]) => ({ symbol, quantity: round(position.quantity), cost: round(position.cost, 2) })))
  });
}
