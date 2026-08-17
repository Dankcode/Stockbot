/**
 * The fill model — one definition of what a trade costs, shared by the
 * backtest core and (once wired) the paper broker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FIXES
 * ─────────────────────────────────────────────────────────────────────────────
 * The legacy engine in server/index.js:1020 does this:
 *
 *     const signal = algorithm.signal({ index, bar, ... });  // bar has close
 *     if (signal === "buy") qty = (cash * 0.95) / bar.close;  // fills at it
 *
 * The strategy is handed the bar's closing price and then transacts at that
 * same price. In live trading you cannot know a bar's close until the bar is
 * over, so you cannot trade at it. Every strategy gets a free look at its own
 * execution price, and it inflates results most for exactly the strategies
 * whose entry rule is a function of the close — which is most of them.
 *
 * This module fills at the NEXT bar's open instead: signal on bar i, execute at
 * bars[i+1].open. That is what a real system does, and it costs about fifteen
 * lines to be honest about.
 *
 * On top of that it charges slippage and commission, because a backtest with
 * zero transaction costs is not a conservative estimate — it is a different
 * question than the one you meant to ask.
 */

/** @typedef {{time: number|string, open: number, high: number, low: number, close: number, volume: number}} Bar */

export const DEFAULT_FILL_MODEL = Object.freeze({
  /** "next_open" (realistic) | "same_close" (legacy, look-ahead) */
  rule: "next_open",
  /** Fixed slippage in basis points, applied against the trade direction. */
  slippageBps: 5,
  /**
   * Additional slippage as a fraction of the bar's true range. Models the fact
   * that a wide, volatile bar costs more to cross than a quiet one — which is
   * why news strategies in particular look better than they trade.
   */
  slippageAtrFraction: 0,
  /** Per-share commission in dollars. */
  commissionPerShare: 0,
  /** Flat per-order commission in dollars. */
  commissionPerOrder: 0,
  /** Fraction of a share to round to. 1 = whole shares only. */
  lotSize: 0,
  /** Fraction of available cash a buy may consume. */
  maxCashFraction: 0.95
});

/**
 * @param {Partial<typeof DEFAULT_FILL_MODEL>} overrides
 * @returns {typeof DEFAULT_FILL_MODEL}
 */
export function createFillModel(overrides = {}) {
  const model = { ...DEFAULT_FILL_MODEL, ...overrides };

  if (!["next_open", "same_close"].includes(model.rule)) {
    throw new RangeError(`fill-model: unknown rule "${model.rule}"`);
  }
  if (model.slippageBps < 0) throw new RangeError("fill-model: slippageBps must be >= 0");
  if (model.maxCashFraction <= 0 || model.maxCashFraction > 1) {
    throw new RangeError("fill-model: maxCashFraction must be in (0, 1]");
  }
  if (model.rule === "same_close") {
    // Permitted so you can reproduce legacy numbers for comparison, but never
    // silently — an inflated result should announce itself.
    process.emitWarning(
      'fill-model: rule "same_close" reproduces the legacy look-ahead bug. ' +
        "Results are optimistic and not tradable. Use it only to quantify the difference.",
      "LookAheadWarning"
    );
  }
  return Object.freeze(model);
}

/** Stable hash of a model, for cache keys and session provenance. */
export function fillModelHash(model) {
  return Object.entries(model)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

/**
 * Resolve the bar index and reference price at which a signal on `signalIndex`
 * actually executes.
 *
 * @param {Bar[]} bars
 * @param {number} signalIndex
 * @param {typeof DEFAULT_FILL_MODEL} model
 * @returns {{index: number, referencePrice: number}|null} null if unfillable
 */
export function resolveExecution(bars, signalIndex, model) {
  if (model.rule === "same_close") {
    const bar = bars[signalIndex];
    return bar ? { index: signalIndex, referencePrice: bar.close } : null;
  }
  const next = bars[signalIndex + 1];
  // A signal on the final bar has no next open to fill against. Dropping it is
  // correct; carrying it to the close would reintroduce the look-ahead.
  if (!next) return null;
  return { index: signalIndex + 1, referencePrice: next.open };
}

/**
 * Apply slippage and compute commission for one fill.
 *
 * @param {object} params
 * @param {"buy"|"sell"} params.side
 * @param {number} params.referencePrice
 * @param {number} params.qty
 * @param {Bar} params.bar the bar the fill occurs in
 * @param {typeof DEFAULT_FILL_MODEL} params.model
 * @returns {{price: number, referencePrice: number, commission: number, slippageCost: number}}
 */
export function priceFill({ side, referencePrice, qty, bar, model }) {
  const direction = side === "buy" ? 1 : -1;

  let slipFraction = model.slippageBps / 10_000;
  if (model.slippageAtrFraction > 0 && bar) {
    const range = Math.max(0, bar.high - bar.low);
    if (referencePrice > 0) {
      slipFraction += (range / referencePrice) * model.slippageAtrFraction;
    }
  }

  // Slippage always works against you: buys fill higher, sells fill lower.
  const price = referencePrice * (1 + direction * slipFraction);
  const commission = model.commissionPerOrder + model.commissionPerShare * qty;
  const slippageCost = Math.abs(price - referencePrice) * qty;

  return { price, referencePrice, commission, slippageCost };
}

/**
 * Size a buy given available cash, honoring lot size and leaving room for costs.
 *
 * @returns {number} quantity, possibly 0
 */
export function sizeBuy({ cash, price, model }) {
  if (!(price > 0)) return 0;
  const budget = cash * model.maxCashFraction;
  // Reserve the per-order commission so the fill cannot overdraw the account.
  const spendable = budget - model.commissionPerOrder;
  if (spendable <= 0) return 0;

  const perShare = price + model.commissionPerShare;
  let qty = spendable / perShare;

  if (model.lotSize > 0) {
    qty = Math.floor(qty / model.lotSize) * model.lotSize;
  }
  return qty > 0 ? qty : 0;
}
