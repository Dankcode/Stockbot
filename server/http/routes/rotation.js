import { Router } from "express";
import { AppError } from "../errors.js";
import { asyncHandler, sendData } from "../middleware.js";

function number(value, name, { min, max, integer = false } = {}) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
    throw new AppError("VALIDATION_ERROR", `${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`, 400);
  }
  return parsed;
}

function rotationOptions(query) {
  const weighting = query.weighting === undefined ? undefined : String(query.weighting);
  if (weighting !== undefined && !["inverse_vol", "equal"].includes(weighting)) {
    throw new AppError("VALIDATION_ERROR", "weighting must be inverse_vol or equal.", 400);
  }
  return {
    topN: number(query.top, "top", { min: 1, max: 40, integer: true }),
    maxPerSector: number(query.maxPerSector, "maxPerSector", { min: 1, max: 40, integer: true }),
    maxWeight: number(query.maxWeight, "maxWeight", { min: 0.01, max: 1 }),
    requireTrend: query.trend === undefined ? undefined : query.trend !== "false",
    weighting
  };
}

/** Read-only: ranking and backtesting place no orders and need no mutation token. */
export function rotationRouter(service) {
  const router = Router();
  router.get("/", asyncHandler(async (request, response) => {
    sendData(response, await service.screen(rotationOptions(request.query)));
  }));
  router.get("/backtest", asyncHandler(async (request, response) => {
    sendData(response, await service.backtest({
      years: number(request.query.years, "years", { min: 1, max: 7 }),
      rebalanceEvery: number(request.query.rebalance, "rebalance", { min: 1, max: 63, integer: true }),
      trailingStop: number(request.query.stop, "stop", { min: 0, max: 0.9 }),
      rotation: rotationOptions(request.query)
    }));
  }));
  return router;
}
