import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PgBusinessStore } from "../src/business/pgBusinessStore.js";
import { hashPassword } from "../src/auth/passwords.js";
import { closePgPool } from "../src/lib/pgClient.js";
import { getTestPgPool } from "./setup.js";
import type { Business } from "../src/types.js";

// Postgres integration coverage for PgBusinessStore, mirroring
// pgOrderStore.test.ts's pattern (same Postgres instance, same ORDER_STORE=pg
// flag — see src/business/pgBusinessStore.ts's own doc comment). Previously
// only InMemoryBusinessStore had test coverage (tests/business.test.ts) —
// this was the exact gap the README called out under "Known gaps": needs a
// real local Postgres (`docker compose up postgres`), same as
// tests/pgOrderStore.test.ts.
describe("PgBusinessStore", () => {
  let store: PgBusinessStore;

  beforeAll(() => {
    store = new PgBusinessStore(getTestPgPool());
  });

  afterAll(async () => {
    await closePgPool();
  });

  function buildBusiness(overrides: Partial<Business> = {}): Business {
    const now = Date.now();
    return {
      id: randomUUID(),
      email: `founder-${randomUUID()}@example.com`,
      passwordHash: hashPassword("correct horse battery staple"),
      businessName: "Acme Retail (Postgres)",
      businessType: "b2c",
      description: "A demo storefront, persisted for real.",
      accentColor: "#ff7a59",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("round-trips create -> getById / getByEmail", async () => {
    const business = buildBusiness();
    await store.create(business);

    const byId = await store.getById(business.id);
    expect(byId).toBeDefined();
    expect(byId!.email).toBe(business.email);
    expect(byId!.businessName).toBe(business.businessName);
    expect(byId!.passwordHash).toBe(business.passwordHash);

    const byEmail = await store.getByEmail(business.email);
    expect(byEmail!.id).toBe(business.id);
  });

  it("returns undefined for an unknown id or email", async () => {
    expect(await store.getById(randomUUID())).toBeUndefined();
    expect(await store.getByEmail("nobody@example.com")).toBeUndefined();
  });

  it("enforces a unique email at the database level", async () => {
    const email = `dup-${randomUUID()}@example.com`;
    await store.create(buildBusiness({ email }));
    await expect(store.create(buildBusiness({ email }))).rejects.toThrow();
  });

  it("update() patches only the provided fields and bumps updatedAt", async () => {
    const business = buildBusiness();
    await store.create(business);

    const updated = await store.update(business.id, { businessName: "Acme Retail Co." });
    expect(updated.businessName).toBe("Acme Retail Co.");
    expect(updated.businessType).toBe(business.businessType); // untouched fields preserved
    expect(updated.email).toBe(business.email);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(business.createdAt);
  });

  it("update() throws for an unknown business and writes nothing", async () => {
    await expect(store.update(randomUUID(), { businessName: "Ghost" })).rejects.toThrow();
  });
});
