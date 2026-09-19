import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// scrypt (Node's built-in, no new dependency) rather than bcrypt/argon2 — the
// project's zero-dependency ethos (see redisClient.ts's RawRespClient) holds
// for auth too: password hashing shouldn't require a native addon or an
// `npm install` before `npm run dev` works.

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // Node's scryptSync defaults, stated explicitly

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS).toString("hex");
  return `scrypt:${salt}:${derivedKey}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, derivedKeyHex] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !derivedKeyHex) return false;

  const candidate = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  const expected = Buffer.from(derivedKeyHex, "hex");
  // Lengths must match before timingSafeEqual — it throws on a mismatch
  // rather than returning false, and KEY_LENGTH is fixed so this only trips
  // on a corrupted/foreign hash.
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
