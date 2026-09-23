import { Router } from "express";
import { AppError } from "../errors.js";
import { asyncHandler, sendData } from "../middleware.js";

const RANGES = new Set(["1H", "1D", "1W", "1M", "3M", "1Y", "ALL"]);
const SOURCES = new Set(["auto", "local", "active"]);

export function selectionRouter(service) {
  const router = Router();
  router.get("/", asyncHandler(async (request, response) => {
    const range = String(request.query.range ?? "1Y").toUpperCase();
    const source = String(request.query.source ?? "auto").toLowerCase();
    if (!RANGES.has(range) || !SOURCES.has(source)) {
      throw new AppError("VALIDATION_ERROR", "range must be a supported range and source must be auto, local, or active.", 400);
    }
    sendData(response, await service.recommend({ range, source, limit: request.query.limit }));
  }));
  return router;
}
