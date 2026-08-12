import { Router } from "express";
import { z } from "zod";
import { asyncHandler, sendData, validate } from "../middleware.js";
import { sessionResource } from "../serializers.js";

const OrderSchema = z.object({
  clientOrderId: z.string().trim().min(1).max(128),
  sessionId: z.string().trim().min(1).max(128).nullable().optional(),
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9./-]+$/),
  side: z.enum(["buy", "sell"]),
  qty: z.number().int().positive(),
  signalReason: z.string().max(500).optional()
}).strict();
const LiquidateSchema = z.object({ operationId: z.string().max(128).optional(), reason: z.string().max(500).optional() }).strict();
const HaltAllSchema = LiquidateSchema.extend({ liquidate: z.boolean().optional() }).strict();

export function accountsRouter({ broker, supervisor }) {
  const router = Router();
  router.get("/:id/portfolio", asyncHandler(async (request, response) => sendData(response, await broker.portfolio(request.params.id))));
  router.post("/:id/orders", validate(OrderSchema), asyncHandler(async (request, response) => {
    const result = await broker.submitOrder({ ...request.body, accountId: request.params.id });
    response.status(result.order.status === "filled" ? 201 : 422); sendData(response, result);
  }));
  router.post("/:id/liquidate", validate(LiquidateSchema), asyncHandler(async (request, response) => sendData(response, await broker.liquidate(request.params.id, request.body))));
  router.post("/:id/halt-all", validate(HaltAllSchema), asyncHandler(async (request, response) => {
    const result = await supervisor.haltAll(request.params.id, request.body);
    sendData(response, {
      ...result,
      halted: (result.halted ?? []).map((item) => ({ ...item, session: sessionResource(item.session) }))
    });
  }));
  return router;
}
