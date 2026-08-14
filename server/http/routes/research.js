import { Router } from "express";
import { z } from "zod";
import { operatorAuth, asyncHandler, sendData, validate } from "../middleware.js";

const PlanSourceSchema = z.object({
  filename: z.string().trim().min(1).max(200).optional(),
  source: z.string().min(1).max(262_144)
}).strict();

const RunPlanSchema = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9./-]{0,31}$/),
  planVersionId: z.string().trim().min(1).max(128).optional()
}).strict();

function requestSignal(request, response) {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

export function researchRouter(service, config) {
  const router = Router();
  router.use(operatorAuth(config));

  router.get("/adapters", (_request, response) => sendData(response, service.adapters.list()));
  router.post("/plans/validate", validate(PlanSourceSchema), asyncHandler(async (request, response) => {
    const result = service.validatePlan(request.body.source);
    sendData(response, { valid: true, plan: result.plan, sourceHash: result.sourceHash });
  }));
  router.post("/plans", validate(PlanSourceSchema), asyncHandler(async (request, response) => {
    const imported = await service.importPlan(request.body);
    response.status(201);
    sendData(response, imported);
  }));
  router.get("/plans", asyncHandler(async (request, response) => {
    sendData(response, await service.listPlans({ limit: Number(request.query.limit) || 50 }));
  }));
  router.get("/plans/:id", asyncHandler(async (request, response) => {
    sendData(response, await service.getPlan(request.params.id));
  }));
  router.post("/plans/:id/runs", validate(RunPlanSchema), asyncHandler(async (request, response) => {
    const result = await service.run({
      planId: request.params.id,
      planVersionId: request.body.planVersionId,
      symbol: request.body.symbol,
      signal: requestSignal(request, response),
      request: { actor: "api" }
    });
    response.status(201);
    sendData(response, result);
  }));
  router.get("/runs", asyncHandler(async (request, response) => {
    sendData(response, await service.listRuns({
      planVersionId: request.query.planVersionId ? String(request.query.planVersionId) : undefined,
      symbol: request.query.symbol ? String(request.query.symbol).toUpperCase() : undefined,
      status: request.query.status ? String(request.query.status) : undefined,
      limit: Number(request.query.limit) || 50
    }));
  }));
  router.get("/runs/:id", asyncHandler(async (request, response) => {
    sendData(response, await service.getRun(request.params.id));
  }));
  router.get("/snapshots/:id", asyncHandler(async (request, response) => {
    sendData(response, await service.getSnapshot(request.params.id));
  }));
  return router;
}
