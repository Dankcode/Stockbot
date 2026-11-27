import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const RequestSchema = z.object({
  symbols: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9./-]{0,31}$/)).min(1).max(10),
  barInterval: z.literal("1day").optional(),
  startNow: z.boolean().optional(),
  includeUploads: z.boolean().optional()
}).strict();

/** Automatic strategy selection: POST starts a job, GET polls it. */
export function strategyPicksRouter(service) {
  const router = Router();
  router.get("/", asyncHandler(async (request, response) => sendData(response, await service.list({ limit: request.query.limit }))));
  router.post("/", validate(RequestSchema), asyncHandler(async (request, response) => {
    response.status(202);
    sendData(response, await service.request(request.body));
  }));
  router.get("/active", asyncHandler(async (_request, response) => sendData(response, await service.active())));
  router.get("/jobs/:jobId", asyncHandler(async (request, response) => sendData(response, await service.getJob(request.params.jobId))));
  router.get("/by-session/:sessionId", asyncHandler(async (request, response) => sendData(response, await service.getBySession(request.params.sessionId))));
  return router;
}
