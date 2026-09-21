import type { Request } from "express";
import { verifySessionToken } from "./session.js";
import { parseCookies, SESSION_COOKIE_NAME } from "./cookies.js";

/**
 * The logged-in business's id for this request, or undefined if there's no
 * valid session cookie. Shared by every route that needs to know "who's
 * asking" — business.ts (account routes), orders.ts and inventory.ts
 * (multi-tenant scoping, see README "Known gaps" / docs/architecture.md).
 * Pulled out of business.ts so those two don't each hand-roll their own
 * copy of "read the cookie, verify the token."
 */
export function currentBusinessId(req: Request): string | undefined {
  return verifySessionToken(parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]);
}
