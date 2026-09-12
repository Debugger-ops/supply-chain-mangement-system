// Seeds a few SKUs with starting stock so the API/dashboard has something to
// demo against. Run with `npm run seed` (uses the same REDIS_DRIVER as the
// server — see .env.example).

import { RawRespClient, createIoRedisClient } from "../src/lib/redisClient.js";
import { InventoryService } from "../src/inventory/inventoryService.js";

async function main() {
  const redis =
    process.env.REDIS_DRIVER === "ioredis"
      ? await createIoRedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:6379")
      : new RawRespClient(process.env.REDIS_HOST ?? "127.0.0.1", Number(process.env.REDIS_PORT ?? 6379));

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
