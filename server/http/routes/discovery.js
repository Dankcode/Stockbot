import { Router } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { asyncHandler, operatorAuth, sendData, validate } from "../middleware.js";

const WatchSchema = z.object({
  status: z.enum(["watching", "researching", "shortlisted", "holding", "rejected"]).optional(),
  note: z.string().max(2_000).optional(),
  sourceRunId: z.string().max(128).optional()
}).strict();
const ResearchSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  question: z.string().trim().max(2_000).optional(),
  scrapers: z.array(z.string().trim().min(1).max(64)).max(10).optional()
}).strict();
const ClaimSchema = z.object({ researcher: z.string().trim().min(1).max(128) }).strict();
const CompleteSchema = z.object({
  result: z.object({
    summary: z.string().trim().min(1).max(20_000),
    verdict: z.enum(["buy_candidate", "hold_candidate", "watch", "avoid"]).optional(),
    evidence: z.array(z.object({ title: z.string().max(500), url: z.string().url().max(2_000).optional(), note: z.string().max(2_000).optional() }).strict()).max(50).optional()
  }).strict()
}).strict();
const FailSchema = z.object({ error: z.string().trim().min(1).max(2_000) }).strict();

function query(request, schema) {
  const parsed = schema.safeParse({ ...request.query });
  if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Request validation failed.", 400, parsed.error.flatten());
  return parsed.data;
}

export function discoveryRouter({ discovery, config }) {
  const router = Router();
  const runQuery = z.object({ lens: z.enum(["growth", "hold"]).default("growth"), limit: z.coerce.number().int().min(1).max(1_000).default(150) }).strict();

  router.get("/screening", (_request, response) => sendData(response, discovery.screeningOptions()));
  router.get("/runs", asyncHandler(async (_request, response) => sendData(response, await discovery.listRuns(20))));
  router.post("/runs", asyncHandler(async (request, response) => {
    response.status(202);
    sendData(response, await discovery.startRun(request.body ?? {}));
  }));
  router.get("/runs/latest", asyncHandler(async (request, response) => {
    const latest = await discovery.latestRun();
    sendData(response, latest ? await discovery.getRun(latest.id, query(request, runQuery)) : null);
  }));
  router.get("/runs/:id", asyncHandler(async (request, response) => sendData(response, await discovery.getRun(String(request.params.id), query(request, runQuery)))));

  router.get("/watchlist", asyncHandler(async (_request, response) => sendData(response, await discovery.watchlist())));
  router.put("/watchlist/:symbol", validate(WatchSchema), asyncHandler(async (request, response) => sendData(response, await discovery.watch(request.params.symbol, request.body))));
  router.delete("/watchlist/:symbol", asyncHandler(async (request, response) => sendData(response, { removed: await discovery.unwatch(request.params.symbol) })));

  router.get("/research/config", asyncHandler(async (_request, response) => sendData(response, discovery.researchConfig())));
  router.get("/research", asyncHandler(async (request, response) => {
    const filters = query(request, z.object({ status: z.enum(["pending", "claimed", "completed", "failed", "cancelled"]).optional(), symbol: z.string().max(12).optional() }).strict());
    sendData(response, await discovery.listResearch(filters));
  }));
  router.post("/research", validate(ResearchSchema), asyncHandler(async (request, response) => {
    response.status(201);
    sendData(response, await discovery.requestResearch(request.body));
  }));
  router.post("/research/:id/cancel", asyncHandler(async (request, response) => sendData(response, await discovery.cancelResearch(String(request.params.id)))));

  // The researcher side of the queue. An LLM researcher assigned later claims a
  // request, does its work, and reports a structured result. Operator-only for now.
  const researcherAuth = operatorAuth(config);
  router.post("/research/:id/claim", researcherAuth, validate(ClaimSchema), asyncHandler(async (request, response) =>
    sendData(response, await discovery.claimResearch(String(request.params.id), request.body.researcher))));
  router.post("/research/:id/complete", researcherAuth, validate(CompleteSchema), asyncHandler(async (request, response) =>
    sendData(response, await discovery.completeResearch(String(request.params.id), request.body.result))));
  router.post("/research/:id/fail", researcherAuth, validate(FailSchema), asyncHandler(async (request, response) =>
    sendData(response, await discovery.failResearch(String(request.params.id), request.body.error))));
  return router;
}
