import { Router } from "express";
import { asyncHandler, sendData } from "../middleware.js";

export function marketRouter(market) {
  const router = Router();

  router.get("/search", asyncHandler(async (request, response) => {
    const query = String(request.query.q ?? request.query.query ?? "").trim();
    sendData(response, await market.search(query, { withQuotes: request.query.quotes === "true", limit: Math.min(50, Number(request.query.limit) || 20) }));
  }));

  router.get("/movers", asyncHandler(async (_request, response) => sendData(response, await market.movers())));
  router.get("/health", (_request, response) => sendData(response, market.providerHealth()));
  router.get("/quote/:symbol", asyncHandler(async (request, response) => sendData(response, await market.getQuote(request.params.symbol))));
  router.get("/bars/:symbol", asyncHandler(async (request, response) => sendData(response, await market.getBars(request.params.symbol, String(request.query.range || "1D")))));

  return router;
}
