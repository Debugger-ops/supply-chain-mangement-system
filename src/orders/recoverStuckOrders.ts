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
 * Known limitation, stated plainly (see README "Known gaps"): this sweep
 * has no distributed lock, so if you ever run more than one replica of this
 * app against the same Postgres, each replica's startup would race to
 * recover the same stuck orders. compensate()'s idempotency (release.lua,
 * PaymentGateway.refund) makes that race harmless rather than corrupting,
 * but it does mean a real multi-replica deployment should elect a single
 * leader to run this sweep (or use `SELECT ... FOR UPDATE SKIP LOCKED`)
 * instead of every replica doing it unconditionally on boot, which is fine
 * for this single-instance k8s Deployment (k8s/base) but is the honest next
 * step before scaling replicas past one.
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
