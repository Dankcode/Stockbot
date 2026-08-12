import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const UploadSchema = z.object({ filename: z.string().min(1).max(128), source: z.string().min(1).max(500_000), overwrite: z.boolean().optional().default(false) }).strict();
const UpdateSchema = z.object({ enabled: z.boolean() }).strict();
const BacktestSchema = z.object({
  symbol: z.string().trim().toUpperCase().min(1).max(32),
  range: z.enum(["1H", "1D", "1W", "1M", "3M", "1Y", "ALL"]).optional(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  fillModel: z.object({
    slippageBps: z.number().min(0).max(1_000).optional(),
    fixedCommission: z.number().min(0).optional(),
    perShareCommission: z.number().min(0).optional(),
    quantityPrecision: z.number().int().min(0).max(8).optional()
  }).strict().optional()
}).strict();

export function algorithmsRouter(service) {
  const router = Router();
  router.get("/", asyncHandler(async (_request, response) => sendData(response, await service.list())));
  router.post("/", validate(UploadSchema), asyncHandler(async (request, response) => {
    const algorithm = await service.upload(request.body);
    response.status(201);
    sendData(response, algorithm);
  }));
  router.get("/:id", asyncHandler(async (request, response) => sendData(response, await service.get(request.params.id, { includeSource: request.query.source === "true" }))));
  router.get("/:id/versions", asyncHandler(async (request, response) => sendData(response, await service.versions(request.params.id))));
  router.patch("/:id", validate(UpdateSchema), asyncHandler(async (request, response) => sendData(response, await service.update(request.params.id, request.body))));
  router.post("/:id/backtest", validate(BacktestSchema), asyncHandler(async (request, response) => sendData(response, await service.backtest(request.params.id, request.body))));
  return router;
}
