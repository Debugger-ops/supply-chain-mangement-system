-- Releases (or commits) a reservation.
--
-- KEYS[1] = stock key
-- KEYS[2] = reservation key
-- ARGV[1] = mode: "RELEASE" (return qty to stock) or "COMMIT" (consume permanently)
--
-- Idempotent: calling this twice for the same reservation is a no-op the
-- second time (the reservation key will already be gone), which matters
-- because saga compensation logic must be safe to retry.

local stockKey = KEYS[1]
local resvKey = KEYS[2]
local mode = ARGV[1]

local qty = tonumber(redis.call("GET", resvKey))
if qty == nil then
  return { "ALREADY_RESOLVED", 0 }
end

redis.call("DEL", resvKey)

if mode == "RELEASE" then
  redis.call("INCRBY", stockKey, qty)
  return { "RELEASED", qty }
elseif mode == "COMMIT" then
  return { "COMMITTED", qty }
else
  return redis.error_reply("INVALID_MODE")
end
