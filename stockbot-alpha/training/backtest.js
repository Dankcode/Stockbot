/**
 * Backtest core — corrected fills, feature support, honest metrics.
 *
 * Differences from the legacy engine at server/index.js:978, all of them
 * findings from the code review:
 *
 *   • Fills at the NEXT bar's open, not the signal bar's close (C2).
 *   • Slippage and commission via the shared fill model (C3).
 *   • Metrics with correct annualization and honest nulls (C7).
 *   • `context.features` — bar-aligned external data, point-in-time correct.
 *
 * Backward compatible: an algorithm written for the existing format
 * (`signal({index, bar, bars, closes, params, state, indicators, position})`)
 * runs here unchanged. `features` is simply an extra key it can ignore.
 */

import { createIndicators } from "./indicators.js";
import { computeMetrics } from "./metrics.js";
import { createFillModel, resolveExecution, priceFill, sizeBuy } from "./fill-model.js";
import { toEpochMs } from "../feeds/align.js";

/** @typedef {import("./fill-model.js").Bar} Bar */

/**
 * Run one backtest.
 *
 * @param {object} params
 * @param {Bar[]} params.bars
 * @param {object} params.algorithm
 * @param {Record<string, any[]>} [params.features] from resolveFeatures()
 * @param {number} [params.startingCash=100000]
 * @param {object} [params.fillModel]
 * @param {Record<string, number>} [params.params] overrides algorithm.params
 * @returns {object}
 */
export function runBacktest({
  bars,
  algorithm,
  features = {},
  startingCash = 100_000,
  fillModel: fillModelOverrides = {},
  params: paramOverrides
}) {
  if (!Array.isArray(bars) || bars.length < 3) {
    throw new Error("runBacktest: need at least 3 bars");
  }
  if (typeof algorithm?.signal !== "function") {
    throw new Error("runBacktest: algorithm must export a signal() function");
  }

  const model = createFillModel(fillModelOverrides);
  const indicators = createIndicators(bars);
  const closes = indicators.closes;
  const params = { ...(algorithm.params ?? {}), ...(paramOverrides ?? {}) };
  const times = bars.map((bar, i) => toEpochMs(bar.time ?? bar.t, `bars[${i}].time`));

  // Validate feature arrays up front. A length mismatch here means the aligner
  // and the bar series disagree, and silently indexing past the end would give
  // `undefined` to a strategy that then behaves unpredictably.
  for (const [name, series] of Object.entries(features)) {
    if (!Array.isArray(series) || series.length !== bars.length) {
      throw new Error(
        `runBacktest: feature "${name}" has length ${series?.length} but there are ${bars.length} bars`
      );
    }
  }

  let state = {};
  if (typeof algorithm.init === "function") {
    state = algorithm.init({ bars, closes, params, indicators, features }) ?? {};
  }

  let cash = startingCash;
  let qty = 0;
  let entryPrice = 0;
  let entryIndex = -1;
  let barsInPosition = 0;
  let totalCosts = 0;
  let lastSignal = null;

  const trades = [];
  const equityCurve = [{ at: times[0], equity: startingCash, cash: startingCash, positionValue: 0 }];
  const rejections = [];

  // Pending order from the previous bar's signal, executed at this bar's open.
  /** @type {{side: "buy"|"sell", signalIndex: number}|null} */
  let pending = null;

  for (let index = 1; index < bars.length; index += 1) {
    const bar = bars[index];

    // ─── 1. Execute anything decided on a previous bar ───────────────────
    if (pending) {
      const execution = resolveExecution(bars, pending.signalIndex, model);
      if (execution && execution.index === index) {
        if (pending.side === "buy" && qty === 0) {
          const provisional = sizeBuy({ cash, price: execution.referencePrice, model });
          if (provisional > 0) {
            const fill = priceFill({
              side: "buy",
              referencePrice: execution.referencePrice,
              qty: provisional,
              bar,
              model
            });
            // Re-size against the slipped price so a wide bar cannot overdraw.
            const finalQty = sizeBuy({ cash, price: fill.price, model });
            if (finalQty > 0) {
              const cost = finalQty * fill.price + fill.commission;
              cash -= cost;
              totalCosts += fill.commission + Math.abs(fill.price - fill.referencePrice) * finalQty;
              qty = finalQty;
              entryPrice = fill.price;
              entryIndex = index;
              trades.push({
                id: `${index}-buy`,
                index,
                at: times[index],
                side: "buy",
                qty: finalQty,
                price: fill.price,
                referencePrice: fill.referencePrice,
                commission: fill.commission,
                signalIndex: pending.signalIndex,
                rule: `${algorithm.name ?? "algorithm"} entry`,
                pnl: null,
                pnlPercent: null
              });
            } else {
              rejections.push({ index, side: "buy", reason: "insufficient_cash_after_slippage" });
            }
          } else {
            rejections.push({ index, side: "buy", reason: "insufficient_cash" });
          }
        } else if (pending.side === "sell" && qty > 0) {
          const fill = priceFill({
            side: "sell",
            referencePrice: execution.referencePrice,
            qty,
            bar,
            model
          });
          const proceeds = qty * fill.price - fill.commission;
          const costBasis = qty * entryPrice;
          const pnl = proceeds - costBasis;
          cash += proceeds;
          totalCosts += fill.commission + Math.abs(fill.price - fill.referencePrice) * qty;
          trades.push({
            id: `${index}-sell`,
            index,
            at: times[index],
            side: "sell",
            qty,
            price: fill.price,
            referencePrice: fill.referencePrice,
            commission: fill.commission,
            signalIndex: pending.signalIndex,
            rule: `${algorithm.name ?? "algorithm"} exit`,
            pnl,
            pnlPercent: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
            heldBars: index - entryIndex
          });
          qty = 0;
          entryPrice = 0;
          entryIndex = -1;
        }
        pending = null;
      } else if (!execution) {
        rejections.push({ index: pending.signalIndex, side: pending.side, reason: "no_next_bar" });
        pending = null;
      }
    }

    // ─── 2. Ask the strategy for a signal on this (closed) bar ───────────
    // The strategy sees bars[0..index] and features[index]. It may not see
    // bars[index + 1], which is where its order will fill.
    const featureView = {};
    for (const [name, series] of Object.entries(features)) featureView[name] = series[index];

    let signal = null;
    try {
      signal = algorithm.signal({
        index,
        bar,
        bars,
        closes,
        state,
        params,
        indicators,
        features: featureView,
        featureSeries: features,
        position: { qty, entryPrice, entryIndex, barsHeld: qty > 0 ? index - entryIndex : 0 }
      });
    } catch (error) {
      // A throwing strategy is a bug in the strategy, not the harness. Record
      // where it happened and stop — a partial result would be misleading.
      throw new Error(`algorithm.signal threw at bar ${index}: ${error.message}`);
    }

    if (index === bars.length - 1) lastSignal = signal ?? null;

    if (signal === "buy" && qty === 0 && !pending) pending = { side: "buy", signalIndex: index };
    else if (signal === "sell" && qty > 0 && !pending) pending = { side: "sell", signalIndex: index };

    // ─── 3. Mark to market ──────────────────────────────────────────────
    if (qty > 0) barsInPosition += 1;
    const positionValue = qty * bar.close;
    equityCurve.push({ at: times[index], equity: cash + positionValue, cash, positionValue });
  }

  // Close any open position at the final close so metrics reflect realized
  // outcomes. Flagged as forced so it is never mistaken for a strategy exit.
  let forcedExit = null;
  if (qty > 0) {
    const finalBar = bars[bars.length - 1];
    const fill = priceFill({
      side: "sell",
      referencePrice: finalBar.close,
      qty,
      bar: finalBar,
      model
    });
    const proceeds = qty * fill.price - fill.commission;
    const costBasis = qty * entryPrice;
    const pnl = proceeds - costBasis;
    cash += proceeds;
    totalCosts += fill.commission + Math.abs(fill.price - fill.referencePrice) * qty;
    forcedExit = {
      id: `${bars.length - 1}-sell-forced`,
      index: bars.length - 1,
      at: times[times.length - 1],
      side: "sell",
      qty,
      price: fill.price,
      referencePrice: fill.referencePrice,
      commission: fill.commission,
      rule: "forced exit at end of window",
      forced: true,
      pnl,
      pnlPercent: costBasis > 0 ? (pnl / costBasis) * 100 : 0,
      heldBars: bars.length - 1 - entryIndex
    };
    trades.push(forcedExit);
    qty = 0;
    equityCurve[equityCurve.length - 1] = {
      at: times[times.length - 1],
      equity: cash,
      cash,
      positionValue: 0
    };
  }

  const metrics = computeMetrics({
    equityCurve,
    trades,
    startingCash,
    barsInPosition,
    totalBars: bars.length - 1,
    totalCosts
  });

  return {
    algorithm: algorithm.name ?? "algorithm",
    params,
    fillModel: model,
    bars: bars.length,
    window: { startMs: times[0], endMs: times[times.length - 1] },
    trades,
    equityCurve,
    rejections,
    lastSignal,
    openPositionAtEnd: forcedExit != null,
    metrics
  };
}

/**
 * Buy-and-hold control over the same bars and the same fill model.
 *
 * Beating this is the only ranking that means anything, which is why it uses
 * the identical cost assumptions rather than a frictionless ideal.
 */
export function runBuyAndHold({ bars, startingCash = 100_000, fillModel = {} }) {
  return runBacktest({
    bars,
    startingCash,
    fillModel,
    algorithm: {
      name: "Buy & Hold — Control",
      // Buy on the first actionable bar, then never sell. The forced exit at
      // the end of the window closes it, so costs are symmetric with any
      // strategy it is compared against.
      signal: ({ index, position }) => (index === 1 && position.qty === 0 ? "buy" : null)
    }
  });
}

/** Flat-cash control. Returns exactly zero, by construction. */
export function runCashControl({ bars, startingCash = 100_000 }) {
  const times = bars.map((bar, i) => toEpochMs(bar.time ?? bar.t, `bars[${i}].time`));
  const equityCurve = times.map((at) => ({ at, equity: startingCash, cash: startingCash, positionValue: 0 }));
  return {
    algorithm: "Cash — Control",
    params: {},
    bars: bars.length,
    window: { startMs: times[0], endMs: times[times.length - 1] },
    trades: [],
    equityCurve,
    rejections: [],
    lastSignal: null,
    openPositionAtEnd: false,
    metrics: computeMetrics({ equityCurve, trades: [], startingCash, totalBars: bars.length - 1 })
  };
}
