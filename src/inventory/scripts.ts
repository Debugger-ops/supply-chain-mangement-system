// Single source of truth for the two Lua scripts InventoryService runs via
// EVAL. Loaded once here and imported by both inventoryService.ts (which
// sends the raw text to Redis) and inMemoryRedis.ts (which recognizes these
// exact scripts by reference, rather than reimplementing a Lua parser, to
// run the same reservation logic in-process — see inMemoryRedis.ts).
//
// Previously each of reserve.lua and release.lua was read from disk inside
// inventoryService.ts directly, with nothing else able to reference "the
// reserve script" as a value without duplicating that readFileSync call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const RESERVE_SCRIPT = readFileSync(path.join(__dirname, "reserve.lua"), "utf8");
export const RELEASE_SCRIPT = readFileSync(path.join(__dirname, "release.lua"), "utf8");
