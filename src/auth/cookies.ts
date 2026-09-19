// Deliberately hand-rolled instead of adding the `cookie`/`cookie-parser`
// dependency — parsing and serializing a single, simple session cookie
// doesn't need a library, and keeps this in line with the rest of the repo's
// "raw unless there's a real reason not to be" approach (RawRespClient,
// InMemoryEventBus, etc.).

export const SESSION_COOKIE_NAME = "scs_session";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // must match auth/session.ts's SESSION_TTL_MS

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value; // malformed percent-encoding — fall back to the raw value rather than 500ing the request
    }
  }
  return out;
}

export function serializeSessionCookie(token: string, opts: { secure: boolean }): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function serializeClearCookie(opts: { secure: boolean }): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}
