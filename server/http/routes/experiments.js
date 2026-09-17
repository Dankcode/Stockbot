import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const ArmSchema = z.object({
  key: z.string().min(1).max(2_000),
  id: z.string().min(1).max(2_000),
  algorithmId: z.string().min(1).max(256),
  kind: z.enum(["strategy", "control"]),
  role: z.string().max(64).optional(),
  horizon: z.string().max(64).optional(),
  params: z.record(z.string(), z.unknown()).optional()
}).passthrough();

const PlanSchema = z.object({
  kind: z.literal("stockbot.experiment.v1"),
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9./-]{0,31}$/),
  range: z.string().trim().min(1).max(32),
  arms: z.array(ArmSchema).min(1).max(1_024),
  groups: z.array(z.object({
    strategy: z.object({ key: z.string().min(1) }).passthrough(),
    controls: z.array(z.object({ key: z.string().min(1) }).passthrough())
  }).passthrough()).min(1).max(32)
}).passthrough();

const CreateExperimentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: z.enum(["backtest", "paper"]).optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
  barInterval: z.enum(["1min", "5min", "1hour", "1day", "1week", "1month"]).optional(),
  plan: PlanSchema,
  selection: z.unknown().optional(),
  fillModel: z.record(z.string(), z.unknown()).optional(),
  riskProfile: z.record(z.string(), z.unknown()).optional(),
  schedule: z.record(z.string(), z.unknown()).optional(),
  windowStart: z.number().int().nonnegative().nullable().optional(),
  windowEnd: z.number().int().nonnegative().nullable().optional()
}).strict();

const HaltSchema = z.object({ liquidate: z.boolean().optional(), reason: z.string().max(500).optional(), operationId: z.string().max(128).optional() }).strict();

export function experimentsRouter(service) {
  const router = Router();
  router.get("/", asyncHandler(async (request, response) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    sendData(response, await service.list({ symbol: request.query.symbol ? String(request.query.symbol).toUpperCase() : undefined, limit }));
  }));
  router.post("/", validate(CreateExperimentSchema), asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await service.create(request.body));
  }));
  router.get("/:id", asyncHandler(async (request, response) => sendData(response, await service.get(request.params.id))));
  router.get("/:id/report", asyncHandler(async (request, response) => sendData(response, await service.report(request.params.id))));
  router.post("/:id/start", asyncHandler(async (request, response) => sendData(response, await service.start(request.params.id))));
  router.post("/:id/halt", validate(HaltSchema), asyncHandler(async (request, response) => sendData(response, await service.halt(request.params.id, request.body))));
  return router;
}
