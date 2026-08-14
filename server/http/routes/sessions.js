import { Router } from "express";
import { z } from "zod";
import { sessionCsv } from "../../reporting/session-report.js";
import { asyncHandler, sendData, validate } from "../middleware.js";
import { sessionCompareResource, sessionDetailResource, sessionResource } from "../serializers.js";

const CreateSessionSchema = z.object({
  accountId: z.string().trim().min(1).max(128).optional(),
  name: z.string().trim().min(1).max(200),
  mode: z.enum(["backtest", "paper"]),
  algorithmVersionId: z.string().min(1),
  researchPlanId: z.string().trim().min(1).max(128).optional(),
  researchPlanVersionId: z.string().trim().min(1).max(128).optional(),
  symbols: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9./-]+$/)).min(1).max(20),
  barInterval: z.enum(["1min", "5min", "1hour", "1day", "1week", "1month"]),
  params: z.record(z.string(), z.unknown()).optional(),
  fillModel: z.record(z.string(), z.unknown()).optional(),
  riskProfile: z.record(z.string(), z.unknown()).optional(),
  schedule: z.record(z.string(), z.unknown()).optional(),
  windowStart: z.number().int().nonnegative().nullable().optional(),
  windowEnd: z.number().int().nonnegative().nullable().optional()
}).strict().superRefine((input, context) => {
  if (input.researchPlanId && input.researchPlanVersionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["researchPlanVersionId"],
      message: "Choose either researchPlanId or researchPlanVersionId, not both."
    });
  }
});

const HaltSchema = z.object({ liquidate: z.boolean().optional(), reason: z.string().max(500).optional(), operationId: z.string().max(128).optional() }).strict();

export function sessionsRouter(supervisor) {
  const router = Router();

  router.get("/", asyncHandler(async (request, response) => {
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    const cursor = request.query.cursor ? Number(Buffer.from(String(request.query.cursor), "base64url").toString("utf8")) : undefined;
    const sessions = await supervisor.list({
      status: request.query.status ? String(request.query.status) : undefined,
      mode: request.query.mode ? String(request.query.mode) : undefined,
      algorithmVersionId: request.query.algorithm ? String(request.query.algorithm) : undefined,
      beforeCreatedAt: Number.isFinite(cursor) ? cursor : undefined,
      limit: limit + 1
    });
    const hasMore = sessions.length > limit;
    const data = sessions.slice(0, limit).map(sessionResource);
    const nextCursor = hasMore ? Buffer.from(String(data.at(-1).createdAt), "utf8").toString("base64url") : null;
    sendData(response, data, { nextCursor, hasMore });
  }));

  router.post("/", validate(CreateSessionSchema), asyncHandler(async (request, response) => {
    const session = await supervisor.create(request.body);
    response.status(201); sendData(response, sessionResource(session));
  }));
  router.get("/compare", asyncHandler(async (request, response) => sendData(response, sessionCompareResource(await supervisor.compare(String(request.query.ids || "").split(",").filter(Boolean))))));
  router.get("/:id", asyncHandler(async (request, response) => sendData(response, sessionDetailResource(await supervisor.get(request.params.id)))));
  router.get("/:id/equity", asyncHandler(async (request, response) => sendData(response, await supervisor.getEquity(request.params.id, { resolution: request.query.resolution ? String(request.query.resolution) : undefined }))));
  router.get("/:id/orders", asyncHandler(async (request, response) => sendData(response, await supervisor.getOrders(request.params.id, { limit: Number(request.query.limit) || 250 }))));
  router.get("/:id/events", asyncHandler(async (request, response) => sendData(response, await supervisor.getEvents(request.params.id, { limit: Number(request.query.limit) || 250 }))));
  router.get("/:id/export", asyncHandler(async (request, response) => {
    const report = await supervisor.exportData(request.params.id);
    const publicReport = { ...report, session: sessionResource(report.session) };
    if (request.query.format === "csv") {
      response.type("text/csv");
      response.setHeader("content-disposition", `attachment; filename="stockbot-${request.params.id}-orders.csv"`);
      response.send(sessionCsv({ session: publicReport.session, orders: publicReport.orders }));
      return;
    }
    response.type("application/json");
    response.setHeader("content-disposition", `attachment; filename="stockbot-${request.params.id}.json"`);
    response.send(JSON.stringify({ data: publicReport, meta: { formatVersion: 1 } }, null, 2));
  }));
  router.post("/:id/start", asyncHandler(async (request, response) => sendData(response, sessionResource(await supervisor.start(request.params.id)))));
  router.post("/:id/pause", asyncHandler(async (request, response) => sendData(response, sessionResource(await supervisor.pause(request.params.id)))));
  router.post("/:id/resume", asyncHandler(async (request, response) => sendData(response, sessionResource(await supervisor.resume(request.params.id)))));
  router.post("/:id/stop", asyncHandler(async (request, response) => sendData(response, sessionResource(await supervisor.stop(request.params.id, request.body || {})))));
  router.post("/:id/halt", validate(HaltSchema), asyncHandler(async (request, response) => {
    const result = await supervisor.halt(request.params.id, request.body);
    sendData(response, { ...result, session: sessionResource(result.session) });
  }));

  return router;
}
