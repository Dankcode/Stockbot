import { Router } from "express";
import { sendData } from "../middleware.js";

export function systemRouter({ config, market, database }) {
  const router = Router();
  router.get("/health", async (_request, response) => {
    const db = await database.health();
    sendData(response, {
      ok: db.ok,
      mode: config.mode,
      host: config.host,
      database: db,
      providers: market.providerHealth(),
      at: Date.now()
    });
  });
  return router;
}
