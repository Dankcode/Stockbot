import { Router } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { asyncHandler, operatorAuth, sendData, validate } from "../middleware.js";

const StatusSchema = z.object({ status: z.enum(["active", "paused", "halted", "retired"]) }).strict();
const ToggleSchema = z.object({ enabled: z.boolean() }).strict();
const TaskSchema = z.object({ expiresInMinutes: z.number().int().min(5).max(720).optional() }).strict();
const PlanSchema = z.object({ plan: z.unknown(), activate: z.boolean().optional() }).strict();

/** Operator console for the swarm. Every route, reads included, needs the operator token. */
export function swarmRouter({ swarm, scheduler, config }) {
  const router = Router();
  router.use(operatorAuth(config));
  const agentId = (request) => String(request.params.id);

  router.get("/", asyncHandler(async (_request, response) => sendData(response, {
    intentsEnabled: await swarm.globalIntentsEnabled(),
    agents: await swarm.listAgents()
  })));
  router.post("/intents", validate(ToggleSchema), asyncHandler(async (request, response) =>
    sendData(response, await swarm.setGlobalIntents(request.body.enabled))));
  router.post("/tick", asyncHandler(async (_request, response) => sendData(response, await scheduler.tickOnce())));

  router.post("/agents", asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await swarm.createAgent(request.body, "operator"));
  }));
  router.get("/agents/:id", asyncHandler(async (request, response) => sendData(response, await swarm.agentDetail(agentId(request)))));
  router.post("/agents/:id/status", validate(StatusSchema), asyncHandler(async (request, response) =>
    sendData(response, await swarm.setAgentStatus(agentId(request), request.body.status))));
  router.post("/agents/:id/intents", validate(ToggleSchema), asyncHandler(async (request, response) =>
    sendData(response, await swarm.setAgentIntents(agentId(request), request.body.enabled))));
  router.post("/agents/:id/tokens", asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await swarm.issueToken(agentId(request)));
  }));
  router.post("/agents/:id/tokens/revoke", asyncHandler(async (request, response) =>
    sendData(response, await swarm.revokeTokens(agentId(request)))));
  router.post("/agents/:id/plans", validate(PlanSchema), asyncHandler(async (request, response) => {
    const saved = await swarm.savePlan(agentId(request), request.body.plan, { actor: "operator", activate: request.body.activate !== false });
    response.status(saved.created ? 201 : 200);
    sendData(response, saved);
  }));
  router.post("/agents/:id/tasks", validate(TaskSchema), asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await swarm.createTask(agentId(request), request.body));
  }));
  router.use((request, _response, next) => next(new AppError("NOT_FOUND", `No swarm route for ${request.method} ${request.path}`, 404)));
  return router;
}
