import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const SettingsSchema = z.object({ settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();

const DatabaseProfileSchema = z.object({
  location: z.enum(["local", "remote"]),
  hostname: z.string().trim().min(1).max(253),
  connectAddress: z.string().trim().max(64).optional().default(""),
  port: z.number().int().min(1).max(65_535),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().max(1_024).optional().default(""),
  sslMode: z.enum(["disable", "require", "verify-full"])
}).strict();

export function settingsRouter(service, market, database) {
  const router = Router();
  router.get("/", asyncHandler(async (_request, response) => sendData(response, await service.publicPayload())));
  router.put("/", validate(SettingsSchema), asyncHandler(async (request, response) => sendData(response, await service.update(request.body.settings))));
  router.post("/providers/test", asyncHandler(async (_request, response) => {
    sendData(response, await market.testProviders("SPY"));
  }));
  router.get("/database", asyncHandler(async (_request, response) => sendData(response, database.publicPayload())));
  router.post("/database/test", validate(DatabaseProfileSchema), asyncHandler(async (request, response) => {
    sendData(response, await database.test(request.body));
  }));
  router.put("/database", validate(DatabaseProfileSchema), asyncHandler(async (request, response) => {
    sendData(response, await database.save(request.body));
  }));
  return router;
}
