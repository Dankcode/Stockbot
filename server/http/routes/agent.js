import { Router } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { asyncHandler, sendData, validate } from "../middleware.js";

const TOKEN_HEADER = "x-stockbot-agent-token";
const RATE_LIMIT_PER_MINUTE = 120;
const FailSchema = z.object({ code: z.string().trim().max(64).optional(), detail: z.string().max(2_000).optional() }).strict();
const TaskQuerySchema = z.object({ status: z.enum(["pending", "claimed", "completed", "failed", "expired"]).optional() }).strict();

/**
 * Authenticates an agent token and nothing else: the operator token is not an
 * agent, so presenting it here is a 401, and an agent token is never accepted
 * by operator routes (they compare against the operator secret only).
 */
export function agentAuth(swarm, { clock = () => Date.now() } = {}) {
  const windows = new Map();
  return asyncHandler(async (request, _response, next) => {
    const presented = request.get(TOKEN_HEADER) || "";
    const resolved = presented ? await swarm.authenticate(presented) : null;
    if (!resolved) throw new AppError("AGENT_AUTH_REQUIRED", "A valid agent token is required.", 401);
    const now = clock();
    const window = windows.get(resolved.tokenId);
    if (!window || now - window.start >= 60_000) windows.set(resolved.tokenId, { start: now, count: 1 });
    else if (++window.count > RATE_LIMIT_PER_MINUTE) throw new AppError("AGENT_RATE_LIMITED", "Too many requests from this agent.", 429);
    request.agent = resolved.agent;
    next();
  });
}

/** The only surface an agent can reach. Every route acts on the caller's own agent id. */
export function agentRouter({ swarm, intents }) {
  const router = Router();
  router.use(agentAuth(swarm));
  router.get("/me", asyncHandler(async (request, response) => {
    const { agent } = request;
    sendData(response, {
      id: agent.id, name: agent.name, status: agent.status, accountId: agent.accountId,
      intentsEnabled: agent.intentsEnabled && await swarm.globalIntentsEnabled()
    });
  }));
  router.get("/portfolio", asyncHandler(async (request, response) => sendData(response, await swarm.portfolio(request.agent))));
  router.get("/tasks", asyncHandler(async (request, response) => {
    // Express 5 exposes request.query as a getter, so parse it rather than reassign it.
    const query = TaskQuerySchema.safeParse({ ...request.query });
    if (!query.success) throw new AppError("VALIDATION_ERROR", "Request validation failed.", 400, query.error.flatten());
    sendData(response, await swarm.listAgentTasks(request.agent, query.data));
  }));
  router.get("/tasks/current", asyncHandler(async (request, response) => sendData(response, await swarm.currentTask(request.agent))));
  router.get("/tasks/:taskId", asyncHandler(async (request, response) =>
    sendData(response, await swarm.getOwnTask(request.agent, String(request.params.taskId)))));
  router.post("/tasks/:taskId/claim", asyncHandler(async (request, response) =>
    sendData(response, await swarm.claimTask(request.agent, String(request.params.taskId)))));
  router.post("/tasks/:taskId/retrievals", asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await swarm.retrieve(request.agent, String(request.params.taskId), request.body));
  }));
  router.post("/tasks/:taskId/report", asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await swarm.submitReport(request.agent, String(request.params.taskId), request.body));
  }));
  router.post("/tasks/:taskId/fail", validate(FailSchema), asyncHandler(async (request, response) =>
    sendData(response, await swarm.failOwnTask(request.agent, String(request.params.taskId), request.body))));
  router.post("/intents", asyncHandler(async (request, response) => {
    const outcome = await intents.submit(request.agent, request.body);
    response.status(outcome.intent.status === "filled" ? 201 : outcome.intent.status === "rejected" || outcome.intent.status === "broker_rejected" ? 422 : 202);
    sendData(response, outcome);
  }));
  router.use((request, _response, next) => next(new AppError("NOT_FOUND", `No agent route for ${request.method} ${request.path}`, 404)));
  return router;
}
