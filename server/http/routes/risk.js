import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const ProfileSchema = z.object({
  name: z.string().min(1).max(120),
  rules: z.record(z.string(), z.unknown()),
  isDefault: z.boolean().optional()
}).strict();

export function riskRouter(repository, accountId) {
  const router = Router();
  router.get("/profiles", asyncHandler(async (_request, response) => sendData(response, await repository.listProfiles(accountId))));
  router.put("/profiles/:id", validate(ProfileSchema), asyncHandler(async (request, response) => sendData(response, await repository.upsertProfile({ id: request.params.id, accountId, ...request.body }))));
  router.get("/events", asyncHandler(async (request, response) => sendData(response, await repository.listEvents({
    accountId,
    sessionId: request.query.session_id ? String(request.query.session_id) : undefined,
    severity: request.query.severity ? String(request.query.severity) : undefined,
    before: request.query.before ? Number(request.query.before) : undefined,
    limit: Number(request.query.limit) || 100
  }))));
  router.post("/events/test", asyncHandler(async (request, response) => {
    const event = await repository.addEvent({ id: crypto.randomUUID(), accountId, at: Date.now(), ruleId: "manual_test", severity: "info", actionTaken: "logged", detail: { note: String(request.body?.note || "Risk event test") } });
    response.status(201); sendData(response, event);
  }));
  return router;
}
