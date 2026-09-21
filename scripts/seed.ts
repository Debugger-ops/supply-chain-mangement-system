// Seeds a few SKUs with starting stock so the API/dashboard has something to
// demo against. Run with `npm run seed` (uses the same REDIS_DRIVER as the
// server — see .env.example). No Redis reachable and nothing to install it
// with? Run `REDIS_DRIVER=memory npm run seed` instead — see
// src/inventory/connectRedis.ts and src/inventory/inMemoryRedis.ts for what
// that trades away.

import { connectRedis } from "../src/inventory/connectRedis.js";
import { InventoryService } from "../src/inventory/inventoryService.js";

async function main() {
  const redis = await connectRedis();

  const inventory = new InventoryService(redis);
  const seedData = [
    { warehouseId: "wh-blr-1", sku: "SKU-LAPTOP-14", qty: 40 },
    { warehouseId: "wh-blr-1", sku: "SKU-MOUSE-WL", qty: 500 },
    { warehouseId: "wh-del-2", sku: "SKU-LAPTOP-14", qty: 15 },
    { warehouseId: "wh-del-2", sku: "SKU-KEYBOARD-MECH", qty: 120 },
  ];

  for (const { warehouseId, sku, qty } of seedData) {
    await inventory.setStock(warehouseId, sku, qty);
    console.log(`Seeded ${warehouseId}/${sku} = ${qty}`);
  }

  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
