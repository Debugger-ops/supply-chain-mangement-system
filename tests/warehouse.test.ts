import { describe, it, expect } from "vitest";
import { InMemoryEventBus } from "../src/lib/eventBus.js";
import { WarehouseNode, emitStockChange } from "../src/warehouse/warehouseSync.js";

describe("WarehouseNode multi-node convergence", () => {
  it("keeps connected nodes in sync in real time", async () => {
    const bus = new InMemoryEventBus();
    const a = new WarehouseNode("wh-a", bus);
    const b = new WarehouseNode("wh-b", bus);

    await emitStockChange(bus, "sku-x", 100, "initial");
    await emitStockChange(bus, "sku-x", -10, "sale");

    expect(a.get("sku-x")).toBe(90);
    expect(b.get("sku-x")).toBe(90);
  });

  it("a disconnected node falls behind but converges after reconnecting, with no lost or duplicated events", async () => {
    const bus = new InMemoryEventBus();
    const a = new WarehouseNode("wh-a", bus);
    const b = new WarehouseNode("wh-b", bus);

    await emitStockChange(bus, "sku-y", 100, "initial");
    b.disconnect();

    for (let i = 0; i < 25; i++) {
      await emitStockChange(bus, "sku-y", -1, `sale-${i}`);
    }

    // While partitioned, B must not silently apply events.
    expect(a.get("sku-y")).toBe(75);
    expect(b.get("sku-y")).toBe(100);

    b.reconnect();

    expect(a.get("sku-y")).toBe(75);
    expect(b.get("sku-y")).toBe(75);
    expect(a.appliedEventCount()).toBe(b.appliedEventCount());
  });

  it("supports more than two nodes converging to the same state", async () => {
    const bus = new InMemoryEventBus();
    const nodes = ["wh-a", "wh-b", "wh-c", "wh-d"].map((id) => new WarehouseNode(id, bus));

    nodes[2].disconnect(); // wh-c goes offline mid-stream

    await emitStockChange(bus, "sku-z", 50, "initial");
    await emitStockChange(bus, "sku-z", -5, "sale-1");
    await emitStockChange(bus, "sku-z", -3, "sale-2");

    nodes[2].reconnect();

    for (const node of nodes) {
      expect(node.get("sku-z")).toBe(42);
    }
  });
});
