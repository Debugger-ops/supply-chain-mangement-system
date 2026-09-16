-- Atomic stock reservation.
--
-- KEYS[1] = stock key, e.g. "stock:{warehouseId}:{sku}" -> integer available count
-- KEYS[2] = reservation key, e.g. "resv:{reservationId}" -> "warehouseId:sku:qty" (for release/commit)
-- ARGV[1] = quantity requested
-- ARGV[2] = reservation id
-- ARGV[3] = reservation TTL in seconds (auto-release if never committed/released —
--           this is what prevents a crashed order-service instance from
--           permanently locking stock)
--
-- Runs as a single Lua script inside Redis, so the read-check-decrement is
-- atomic across every concurrent caller — this is the whole trick that makes
-- "never oversell under concurrency" possible without a distributed lock.

local stockKey = KEYS[1]
local resvKey = KEYS[2]
local qty = tonumber(ARGV[1])
local reservationId = ARGV[2]
local ttl = tonumber(ARGV[3])

if qty == nil or qty <= 0 then
  return redis.error_reply("INVALID_QTY")
end

local available = tonumber(redis.call("GET", stockKey))
if available == nil then
  -- Unlike INVALID_QTY (a client-code bug, pre-validated in TS before this
  -- script even runs), an unknown SKU is a normal, expected outcome — a
  -- caller referencing a SKU nobody has PUT stock for yet. Returning it as
  -- an error reply (like INVALID_QTY does) would surface as a Redis
  -- protocol error instead of a rejection result, which the raw RESP
  -- client has no way to route back to the specific caller as anything
  -- but a thrown exception. Report it the same shape as INSUFFICIENT_STOCK
  -- instead, so InventoryService.reserve() can turn it into an ordinary
  -- { ok: false, reason: "UNKNOWN_SKU" } result.
  return { "UNKNOWN_SKU", 0 }
end

if available < qty then
  return { "INSUFFICIENT_STOCK", available }
end

redis.call("DECRBY", stockKey, qty)
redis.call("SET", resvKey, qty, "EX", ttl)
local remaining = available - qty
return { "OK", remaining }
