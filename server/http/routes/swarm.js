import { Router } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { asyncHandler, operatorAuth, sendData, validate } from "../middleware.js";
import { isTradingDate, nyDate, previousTradingDate } from "../../swarm/calendar.js";

const StatusSchema = z.object({ status: z.enum(["active", "paused", "halted", "retired"]) }).strict();
const ToggleSchema = z.object({ enabled: z.boolean() }).strict();
const TaskSchema = z.object({ expiresInMinutes: z.number().int().min(5).max(720).optional() }).strict();
const PlanSchema = z.object({ plan: z.unknown(), activate: z.boolean().optional() }).strict();
const AutomationSchema = z.object({
  discoverySchedule: z.boolean().optional(),
  review: z.boolean().optional(),
  discoveryPreset: z.string().max(64).optional()
}).strict();
const ReviewSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();

/** Operator console for the swarm. Every route, reads included, needs the operator token. */
export function swarmRouter({ swarm, scheduler, config, swarmExperiments, swarmJobs, swarmReview }) {
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

  if (swarmExperiments) {
    router.get("/automation", asyncHandler(async (_request, response) => sendData(response, await swarmJobs.automation())));
    router.post("/automation", validate(AutomationSchema), asyncHandler(async (request, response) =>
      sendData(response, await swarmJobs.setAutomation(request.body))));
    router.get("/experiments", asyncHandler(async (_request, response) => sendData(response, await swarmExperiments.listExperiments())));
    router.post("/experiments", asyncHandler(async (request, response) => {
      response.status(201);
      sendData(response, await swarmExperiments.createExperiment(request.body, "operator"));
    }));
    router.get("/experiments/:id", asyncHandler(async (request, response) =>
      sendData(response, await swarmExperiments.detail(String(request.params.id)))));
    router.get("/experiments/:id/comparison", asyncHandler(async (request, response) =>
      sendData(response, await swarmExperiments.comparison(String(request.params.id)))));
    // Operator-forced review for a date (default: the latest trading date's close). Runs the full gauntlet.
    router.post("/experiments/:id/review", validate(ReviewSchema), asyncHandler(async (request, response) => {
      const experiment = await swarmExperiments.requireExperiment(String(request.params.id));
      const today = nyDate(Date.now());
      const date = request.body.date ?? (isTradingDate(today) ? today : previousTradingDate(today));
      sendData(response, await swarmReview.run(experiment.id, date, { force: true }));
    }));
  }
  router.use((request, _response, next) => next(new AppError("NOT_FOUND", `No swarm route for ${request.method} ${request.path}`, 404)));
  return router;
}
