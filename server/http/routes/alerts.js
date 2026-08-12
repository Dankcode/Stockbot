import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const AlertSchema = z.object({
  name: z.string().min(1).max(120),
  triggerType: z.enum(["metric_threshold", "risk_event", "session_state", "signal", "schedule"]),
  condition: z.record(z.string(), z.unknown()),
  channel: z.literal("in_app").default("in_app"),
  enabled: z.boolean().optional(),
  cooldownMs: z.number().int().min(0).max(604_800_000).optional()
}).strict();

export function alertsRouter(repository, accountId) {
  const router = Router();
  router.get("/", asyncHandler(async (_request, response) => sendData(response, await repository.list({ accountId }))));
  router.post("/", validate(AlertSchema), asyncHandler(async (request, response) => {
    const alert = await repository.create({ id: crypto.randomUUID(), accountId, ...request.body });
    response.status(201); sendData(response, alert);
  }));
  router.patch("/:id", asyncHandler(async (request, response) => sendData(response, await repository.update(request.params.id, request.body))));
  router.post("/deliveries/:id/ack", asyncHandler(async (request, response) => sendData(response, await repository.acknowledgeDelivery(request.params.id))));
  router.get("/feed", asyncHandler(async (request, response) => sendData(response, await repository.feed(accountId, { since: request.query.since ? Number(request.query.since) : undefined, limit: Number(request.query.limit) || 100 }))));
  return router;
}
