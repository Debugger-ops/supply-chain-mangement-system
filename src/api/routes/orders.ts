import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import type { SagaOrchestrator } from "../../orders/sagaOrchestrator.js";
import type { OrderStore } from "../../orders/orderStore.js";

const createOrderSchema = z.object({
  customerId: z.string().min(1),
  amountCents: z.number().int().positive(),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        qty: z.number().int().positive(),
        warehouseId: z.string().min(1),
      })
    )
    .min(1),
});

export function ordersRouter(saga: SagaOrchestrator, store: OrderStore): Router {
  const router = Router();

  // Validate at the request boundary and reject malformed payloads before
  // they reach the saga — same pattern as Finflow's Zod-validated REST APIs.
  router.post("/orders", asyncHandler(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
    }
    const { customerId, lines, amountCents } = parsed.data;
    const orderId = await saga.createOrder(customerId, lines, amountCents);
    const order = await saga.run(orderId);
    const statusCode = order.status === "CONFIRMED" ? 201 : 422;
    res.status(statusCode).json(order);
  }));

  router.get("/orders/:id", asyncHandler(async (req, res) => {
    const order = await store.get(req.params.id);
    if (!order) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(order);
  }));

  router.get("/orders", asyncHandler(async (_req, res) => {
    res.json(await store.all());
  }));

  return router;
}
