import { describe, it, expect, vi } from "vitest";
import { InMemoryBusinessStore } from "../src/business/businessStore.js";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { createSessionToken, verifySessionToken } from "../src/auth/session.js";
import type { Business } from "../src/types.js";

function buildBusiness(overrides: Partial<Business> = {}): Business {
  const now = Date.now();
  return {
    id: "biz-1",
    email: "founder@example.com",
    passwordHash: hashPassword("correct horse battery staple"),
    businessName: "Acme Retail",
    businessType: "b2c",
    description: "A demo storefront.",
    accentColor: "#ff7a59",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("passwords", () => {
  it("verifies a matching password and rejects a wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("salts every hash differently, even for the same password", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });
});

describe("session tokens", () => {
  it("round-trips a valid token back to its businessId", () => {
    const token = createSessionToken("biz-123");
    expect(verifySessionToken(token)).toBe("biz-123");
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken("biz-123");
    const [businessId, expiresAt, signature] = token.split(".");
    const tampered = `${businessId}-evil.${expiresAt}.${signature}`;
    expect(verifySessionToken(tampered)).toBeUndefined();
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
      const token = createSessionToken("biz-123");
      vi.setSystemTime(new Date("2020-02-15T00:00:00Z")); // 45 days later, past the 30-day TTL
      expect(verifySessionToken(token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects garbage input", () => {
    expect(verifySessionToken(undefined)).toBeUndefined();
    expect(verifySessionToken("")).toBeUndefined();
    expect(verifySessionToken("not-a-real-token")).toBeUndefined();
  });
});

describe("InMemoryBusinessStore", () => {
  it("creates, fetches by id and by email, and updates a business", async () => {
    const store = new InMemoryBusinessStore();
    const business = buildBusiness();
    await store.create(business);

    expect(await store.getById(business.id)).toEqual(business);
    expect(await store.getByEmail(business.email)).toEqual(business);
    expect(await store.getByEmail("nobody@example.com")).toBeUndefined();

    const updated = await store.update(business.id, { businessName: "Acme Retail Co." });
    expect(updated.businessName).toBe("Acme Retail Co.");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(business.createdAt);
  });

  it("throws when updating an unknown business", async () => {
    const store = new InMemoryBusinessStore();
    await expect(store.update("nope", { businessName: "X" })).rejects.toThrow();
  });
});
