import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Stateless, HMAC-signed session tokens — no session table/Redis key to
// manage, no extra infra beyond what's already here. Trade-off, stated
// plainly: a token can't be revoked before it expires (no server-side
// blocklist), which is fine for a 30-day demo/portfolio session but is the
// first thing to change (e.g. a Redis-backed denylist, reusing RedisLike)
// before this became a real product's auth.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let devFallbackSecret: string | undefined;

function getSecret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (!devFallbackSecret) {
    devFallbackSecret = randomBytes(32).toString("hex");
    console.warn(
      "[auth] SESSION_SECRET is not set — using a random secret generated for this " +
        "process only. Every restart invalidates existing sessions. Set SESSION_SECRET " +
        "in .env for stable sessions (see .env.example)."
    );
  }
  return devFallbackSecret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("hex");
}

export function createSessionToken(businessId: string): string {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${businessId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

/** Returns the businessId if the token is well-formed, unexpired, and its signature checks out — undefined otherwise. */
export function verifySessionToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [businessId, expiresAtStr, signature] = parts;
  if (!businessId || !expiresAtStr || !signature) return undefined;

  const expected = sign(`${businessId}.${expiresAtStr}`);
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return undefined;

  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return undefined;

  return businessId;
}
