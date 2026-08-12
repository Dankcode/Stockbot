import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";

const SettingsSchema = z.object({ settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();

export function settingsRouter(service, market) {
  const router = Router();
  router.get("/", asyncHandler(async (_request, response) => sendData(response, await service.publicPayload())));
  router.put("/", validate(SettingsSchema), asyncHandler(async (request, response) => sendData(response, await service.update(request.body.settings))));
  router.post("/providers/test", asyncHandler(async (_request, response) => {
    sendData(response, await market.testProviders("SPY"));
  }));
  return router;
}
