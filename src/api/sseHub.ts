import type { Response } from "express";
import type { EventBus } from "../lib/eventBus.js";

/**
 * Fans out every event published on the "orders" topic to connected
 * dashboard clients over Server-Sent Events — the same live-dashboard
 * pattern used in FlowGate, applied here to order/saga state transitions
 * instead of rate-limit decisions.
 */
export class SseHub {
  private clients = new Set<Response>();

  constructor(eventBus: EventBus) {
    eventBus.subscribe("orders", "sse-hub", (event) => {
      this.broadcast(event);
    });
  }

  addClient(res: Response): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  private broadcast(event: unknown): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }
}
