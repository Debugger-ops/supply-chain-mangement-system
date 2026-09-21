import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../asyncHandler.js";
import { currentBusinessId } from "../../auth/currentBusiness.js";
import type { InventoryService } from "../../inventory/inventoryService.js";

const setStockSchema = z.object({
  warehouseId: z.string().min(1),
  sku: z.string().min(1),
  qty: z.number().int().min(0),
});

export function inventoryRouter(inventory: InventoryService): Router {
  const router = Router();

  // Requires an authenticated business session. Reads (below) stay public —
  // warehouse stock levels are shared 3PL infrastructure in this domain
  // model, not partitioned per business the way orders are (see
  // docs/architecture.md) — but writing to that shared resource is exactly
  // the kind of request a real multi-tenant system attributes to a specific
  // tenant rather than leaving open to anyone, which is the gap this closes:
  // previously any anonymous caller could overwrite any warehouse's stock.
  router.put("/inventory", asyncHandler(async (req, res) => {
    if (!currentBusinessId(req)) {
      return res.status(401).json({ error: "UNAUTHENTICATED", message: "Log in to update warehouse stock." });
    }
    const parsed = setStockSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_PAYLOAD", details: parsed.error.flatten() });
    }
    const { warehouseId, sku, qty } = parsed.data;
    await inventory.setStock(warehouseId, sku, qty);
    res.status(204).end();
  }));

  // Every (warehouseId, sku) this process has touched, with current available
  // stock — powers the dashboard's inventory table.
  router.get("/inventory", asyncHandler(async (_req, res) => {
    res.json(await inventory.listAll());
  }));

  router.get("/inventory/:warehouseId/:sku", asyncHandler(async (req, res) => {
    const { warehouseId, sku } = req.params;
    const available = await inventory.getAvailable(warehouseId, sku);
    res.json({ warehouseId, sku, available });
  }));

  return router;
}
