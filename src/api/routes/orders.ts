import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { currentBusinessId } from "../../auth/currentBusiness.js";
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

/**
 * Multi-tenant order scoping. An authenticated request only ever sees its
 * own business's orders; an unauthenticated one only sees the shared
 * anonymous/demo pool (orders created without logging in) — never a mix,
 * and never another business's orders. `undefined` is reserved for the
 * saga's own internal store access (SagaOrchestrator, the recovery sweep),
 * which isn't a request and isn't scoped. See docs/architecture.md.
 */
function scopeFor(req: Request): string | null {
  return currentBusinessId(req) ?? null;
}

export function ordersRouter(saga: SagaOrchestrator, store: OrderStore): Router {
  const router = Router();

  // Validate at the request boundary and reject malformed payloads before
  // they reach the saga — same pattern as Finflow's Zod-validated REST APIs.
  //
  // Async execution: this handler returns as soon as the order is created
  // and `order.created` is published — it does NOT wait for the saga to
  // finish reserving inventory, charging payment, and scheduling shipping.
  // A dedicated event-bus subscriber (wireAsyncSagaExecution, registered
  // once at startup in api/server.ts) picks up `order.created` and drives
  // the rest of the saga in the background. Poll GET /api/orders/:id, or
  // watch GET /api/events/stream, for the final outcome. See
  // docs/architecture.md "Async saga execution" for the full rationale.
  router.post("/orders", asyncHandler(async (req, res) => {
    const parsed = createOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
    }
    const { customerId, lines, amountCents } = parsed.data;
    const businessId = scopeFor(req);
    const orderId = await saga.createOrder(customerId, lines, amountCents, businessId);
    const order = await store.get(orderId, undefined);
    res.status(202).location(`/api/orders/${orderId}`).json(order);
  }));

  router.get("/orders/:id", asyncHandler(async (req, res) => {
    const order = await store.get(req.params.id, scopeFor(req));
    if (!order) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(order);
  }));

  router.get("/orders", asyncHandler(async (req, res) => {
    res.json(await store.all(scopeFor(req)));
  }));

  return router;
}
