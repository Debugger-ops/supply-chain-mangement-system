import type { OrderStore } from "./orderStore.js";
import type { SagaOrchestrator } from "./sagaOrchestrator.js";

/**
 * Startup recovery sweep — called once from api/server.ts's main() after
 * the store and saga are both constructed, before the HTTP server starts
 * accepting traffic. Finds every order OrderStore.nonTerminal() considers
 * left mid-saga (anything that isn't CONFIRMED/CANCELLED/FAILED — see
 * orderStore.ts's TERMINAL_ORDER_STATUSES) and rolls each one back to
 * CANCELLED via SagaOrchestrator.recoverStuck(), the same idempotent
 * compensating-transaction path every other failure uses.
 *
 * With InMemoryOrderStore this is always a no-op (a fresh in-memory store
 * has no orders yet), so it's safe to always call this rather than gate it
 * behind ORDER_STORE=pg. It only does real work when Postgres-backed order
 * history survives the restart that triggered this sweep in the first
 * place.
 *
 * Known limitation, stated plainly (see README "Known gaps"): this sweep has
 * no distributed lock, and k8s/base/app-deployment.yaml already runs 2+
 * replicas by default (3+ under k8s/overlays/prod) — specifically because
 * the whole point of this project is correctness *across* multiple
 * concurrently-running instances (see docs/architecture.md's "Deployment
 * topology"). So on a real rolling restart or a fresh rollout, every
 * replica that boots runs this sweep against the same Postgres at close to
 * the same time, each racing to recover the same handful of stuck orders.
 * compensate()'s idempotency (release.lua's already-resolved-reservation
 * check, PaymentGateway.refund's no-op-if-nothing-charged) makes that race
 * harmless rather than corrupting — two replicas both calling
 * recoverStuck() on the same order both just re-derive CANCELLED — but it
 * is real wasted work (duplicate refund/cancel calls to the payment/
 * shipping providers) that a single-instance deployment wouldn't have. The
 * honest next step, not done here: elect one leader to run the sweep (a
 * Postgres advisory lock, or `SELECT ... FOR UPDATE SKIP LOCKED` on the
 * nonTerminal() query) instead of every replica doing it unconditionally on
 * boot.
 */
export async function recoverStuckOrders(store: OrderStore, saga: SagaOrchestrator): Promise<number> {
  const stuck = await store.nonTerminal();
  for (const order of stuck) {
    console.warn(
      `[recovery] Order ${order.id} was left in ${order.status} — likely a crash mid-saga. ` +
        `Compensating to CANCELLED.`
    );
    await saga.recoverStuck(order);
  }
  if (stuck.length > 0) {
    console.warn(`[recovery] Recovered ${stuck.length} order(s) left mid-saga by a previous process.`);
  }
  return stuck.length;
}
