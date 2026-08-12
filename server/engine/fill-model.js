const MONEY_PRECISION = 10;

export const DEFAULT_FILL_MODEL = Object.freeze({
  slippageBps: 0,
  fixedCommission: 0,
  perShareCommission: 0,
  quantityPrecision: 6
});

function finiteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${name} must be a finite, non-negative number.`);
  }
  return number;
}

function round(value, precision = MONEY_PRECISION) {
  return Number(value.toFixed(precision));
}

function floorTo(value, precision) {
  const factor = 10 ** precision;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

export function normalizeFillModel(model = {}) {
  const quantityPrecision = Number(model.quantityPrecision ?? DEFAULT_FILL_MODEL.quantityPrecision);
  if (!Number.isInteger(quantityPrecision) || quantityPrecision < 0 || quantityPrecision > 12) {
    throw new TypeError("quantityPrecision must be an integer between 0 and 12.");
  }

  const slippageBps = finiteNonNegative(
    model.slippageBps ?? DEFAULT_FILL_MODEL.slippageBps,
    "slippageBps"
  );
  if (slippageBps >= 10_000) {
    throw new TypeError("slippageBps must be less than 10,000 so sell fills remain positive.");
  }

  return Object.freeze({
    slippageBps,
    fixedCommission: finiteNonNegative(
      model.fixedCommission ?? DEFAULT_FILL_MODEL.fixedCommission,
      "fixedCommission"
    ),
    perShareCommission: finiteNonNegative(
      model.perShareCommission ?? DEFAULT_FILL_MODEL.perShareCommission,
      "perShareCommission"
    ),
    quantityPrecision
  });
}

export function slippedPrice(side, referencePrice, slippageBps = 0) {
  if (side !== "buy" && side !== "sell") throw new TypeError(`Unsupported fill side: ${side}.`);
  const reference = Number(referencePrice);
  if (!Number.isFinite(reference) || reference <= 0) {
    throw new TypeError("referencePrice must be a positive finite number.");
  }
  const bps = finiteNonNegative(slippageBps, "slippageBps");
  if (bps >= 10_000) throw new TypeError("slippageBps must be less than 10,000.");
  const direction = side === "buy" ? 1 : -1;
  return round(reference * (1 + direction * bps / 10_000));
}

export function commissionFor(quantity, model = DEFAULT_FILL_MODEL) {
  const normalized = normalizeFillModel(model);
  const shares = finiteNonNegative(quantity, "quantity");
  return round(normalized.fixedCommission + normalized.perShareCommission * shares);
}

/** Returns the auditable economics of a fill. `cashDelta` is negative for buys. */
export function calculateFill({ side, quantity, referencePrice }, model = DEFAULT_FILL_MODEL) {
  const normalized = normalizeFillModel(model);
  const shares = finiteNonNegative(quantity, "quantity");
  if (shares === 0) throw new TypeError("quantity must be greater than zero.");

  const price = slippedPrice(side, referencePrice, normalized.slippageBps);
  const grossNotional = round(price * shares);
  const commission = commissionFor(shares, normalized);
  const cashDelta = round(side === "buy" ? -(grossNotional + commission) : grossNotional - commission);

  return Object.freeze({
    side,
    quantity: shares,
    referencePrice: Number(referencePrice),
    price,
    grossNotional,
    commission,
    cashDelta,
    slippageCost: round(Math.abs(price - Number(referencePrice)) * shares)
  });
}

/**
 * Sizes a buy so price, fixed commission, and per-share commission all fit
 * inside `cashBudget`. Quantity is floored rather than rounded to avoid debt.
 */
export function affordableQuantity({ cashBudget, referencePrice }, model = DEFAULT_FILL_MODEL) {
  const normalized = normalizeFillModel(model);
  const budget = finiteNonNegative(cashBudget, "cashBudget");
  const price = slippedPrice("buy", referencePrice, normalized.slippageBps);
  const available = budget - normalized.fixedCommission;
  if (available <= 0) return 0;
  return floorTo(available / (price + normalized.perShareCommission), normalized.quantityPrecision);
}
