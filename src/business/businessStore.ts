import type { Business, BusinessProfilePatch } from "../types.js";

/**
 * Minimal persistence interface for registered businesses, mirroring
 * orders/orderStore.ts's OrderStore: InMemoryBusinessStore is used by tests
 * and local dev by default; PgBusinessStore (schema in docs/schema.sql) is
 * the production implementation over Postgres — swap via ORDER_STORE=pg
 * (the same flag that swaps OrderStore, since it's the same database).
 */
export interface BusinessStore {
  create(business: Business): Promise<void>;
  getById(id: string): Promise<Business | undefined>;
  getByEmail(email: string): Promise<Business | undefined>;
  update(id: string, patch: BusinessProfilePatch): Promise<Business>;
}

export class InMemoryBusinessStore implements BusinessStore {
  private byId = new Map<string, Business>();
  private idByEmail = new Map<string, string>(); // email is already lowercased by the route's Zod schema

  async create(business: Business): Promise<void> {
    this.byId.set(business.id, business);
    this.idByEmail.set(business.email, business.id);
  }

  async getById(id: string): Promise<Business | undefined> {
    return this.byId.get(id);
  }

  async getByEmail(email: string): Promise<Business | undefined> {
    const id = this.idByEmail.get(email);
    return id ? this.byId.get(id) : undefined;
  }

  async update(id: string, patch: BusinessProfilePatch): Promise<Business> {
    const business = this.byId.get(id);
    if (!business) throw new Error(`Unknown business ${id}`);
    Object.assign(business, patch, { updatedAt: Date.now() });
    return business;
  }
}
