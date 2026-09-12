import type { FailureInjection } from "../types.js";

export interface ShippingResult {
  ok: boolean;
  shipmentId?: string;
  reason?: string;
}

export class ShippingProvider {
  private shipments = new Map<string, string>();

  constructor(private failureInjection: FailureInjection = {}) {}

  async schedule(orderId: string, warehouseId: string): Promise<ShippingResult> {
    if (this.failureInjection.failShippingForOrderIds?.has(orderId)) {
      return { ok: false, reason: "NO_COURIER_AVAILABLE" };
    }
    const shipmentId = `ship_${orderId}`;
    this.shipments.set(orderId, shipmentId);
    return { ok: true, shipmentId };
  }

  async cancel(orderId: string): Promise<{ ok: boolean }> {
    this.shipments.delete(orderId);
    return { ok: true };
  }
}
