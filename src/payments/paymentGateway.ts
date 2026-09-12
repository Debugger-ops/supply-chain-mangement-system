import type { FailureInjection } from "../types.js";

export interface PaymentResult {
  ok: boolean;
  paymentId?: string;
  reason?: string;
}

/**
 * Stands in for a real payment processor (Razorpay/Stripe-shaped interface).
 * The saga only depends on this interface, so swapping in a real gateway
 * later is a one-file change. `failFor` lets tests/demos force a specific
 * order's payment to fail deterministically, to exercise the compensation
 * path without relying on randomness.
 */
export class PaymentGateway {
  private charges = new Map<string, string>(); // orderId -> paymentId, for idempotent refunds

  constructor(private failureInjection: FailureInjection = {}) {}

  async charge(orderId: string, amountCents: number): Promise<PaymentResult> {
    if (this.failureInjection.failPaymentForOrderIds?.has(orderId)) {
      return { ok: false, reason: "CARD_DECLINED" };
    }
    const paymentId = `pay_${orderId}`;
    this.charges.set(orderId, paymentId);
    return { ok: true, paymentId };
  }

  async refund(orderId: string): Promise<{ ok: boolean; alreadyRefunded?: boolean }> {
    if (!this.charges.has(orderId)) return { ok: true, alreadyRefunded: true };
    this.charges.delete(orderId);
    return { ok: true };
  }
}
