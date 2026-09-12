import type { EventBus, DomainEvent } from "../lib/eventBus.js";

const STOCK_EVENTS_TOPIC = "stock-events";

/**
 * Simulates one warehouse node's local view of stock levels. Each node
 * applies stock-change events (from local reservations/commits, or from the
 * central inventory service) through its own consumer-group cursor on the
 * shared event log — so a node that's offline (network partition, restart)
 * just falls behind and catches up by replaying the events it missed, and
 * converges to the same state as every other node without a coordinator.
 *
 * This models the realistic failure mode in a multi-warehouse system: a
 * regional node loses connectivity to the central event log for a while
 * (deploy, network blip, AZ failure) but must not lose or double-apply any
 * stock movement once it reconnects.
 */
export class WarehouseNode {
  private localStock = new Map<string, number>(); // sku -> qty
  private connected = true;
  private appliedCount = 0;

  constructor(public readonly nodeId: string, private eventBus: EventBus) {
    this.eventBus.subscribe(STOCK_EVENTS_TOPIC, `warehouse-node:${nodeId}`, async (event) => {
      if (!this.connected) return; // simulate a partition: events pile up in the log, unread
      this.apply(event);
    });
  }

  private apply(event: DomainEvent) {
    const { sku, delta } = event.payload as { sku: string; delta: number };
    const current = this.localStock.get(sku) ?? 0;
    this.localStock.set(sku, current + delta);
    this.appliedCount++;
  }

  get(sku: string): number {
    return this.localStock.get(sku) ?? 0;
  }

  appliedEventCount(): number {
    return this.appliedCount;
  }

  /** Simulates a network partition: this node stops consuming new events. */
  disconnect(): void {
    this.connected = false;
  }

  /**
   * Simulates the partition healing: replays every event the node missed
   * while disconnected, in order, from its own last-seen cursor — exactly
   * what a real Kafka consumer group does automatically on reconnect.
   */
  reconnect(): void {
    this.connected = true;
    const missed = this.eventBus.history(STOCK_EVENTS_TOPIC).slice(this.appliedCount);
    for (const event of missed) this.apply(event);
  }
}

/** Publishes a stock-level change (e.g. from a central inventory commit) for all warehouse nodes to converge on. */
export async function emitStockChange(eventBus: EventBus, sku: string, delta: number, reason: string): Promise<void> {
  await eventBus.publish(STOCK_EVENTS_TOPIC, {
    type: "stock.changed",
    payload: { sku, delta, reason },
    at: Date.now(),
  });
}

export { STOCK_EVENTS_TOPIC };
