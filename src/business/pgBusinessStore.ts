import type { Pool } from "pg";
import type { Business, BusinessProfilePatch, BusinessType } from "../types.js";
import type { BusinessStore } from "./businessStore.js";

interface BusinessRow {
  id: string;
  email: string;
  password_hash: string;
  business_name: string;
  business_type: BusinessType;
  description: string;
  accent_color: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Postgres-backed BusinessStore (docs/schema.sql). Selected the same way as
 * PgOrderStore — ORDER_STORE=pg in server.ts — since it's the same Postgres
 * instance; InMemoryBusinessStore remains the default and is what the test
 * suite uses.
 */
export class PgBusinessStore implements BusinessStore {
  constructor(private pool: Pool) {}

  async create(business: Business): Promise<void> {
    await this.pool.query(
      `INSERT INTO businesses (id, email, password_hash, business_name, business_type, description, accent_color, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))`,
      [
        business.id,
        business.email,
        business.passwordHash,
        business.businessName,
        business.businessType,
        business.description,
        business.accentColor,
        business.createdAt,
        business.updatedAt,
      ]
    );
  }

  async getById(id: string): Promise<Business | undefined> {
    const result = await this.pool.query<BusinessRow>(`SELECT * FROM businesses WHERE id = $1`, [id]);
    const row = result.rows[0];
    return row ? this.toBusiness(row) : undefined;
  }

  async getByEmail(email: string): Promise<Business | undefined> {
    const result = await this.pool.query<BusinessRow>(`SELECT * FROM businesses WHERE email = $1`, [email]);
    const row = result.rows[0];
    return row ? this.toBusiness(row) : undefined;
  }

  async update(id: string, patch: BusinessProfilePatch): Promise<Business> {
    const result = await this.pool.query<BusinessRow>(
      `UPDATE businesses SET
         business_name = COALESCE($2, business_name),
         business_type = COALESCE($3, business_type),
         description = COALESCE($4, description),
         accent_color = COALESCE($5, accent_color),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, patch.businessName ?? null, patch.businessType ?? null, patch.description ?? null, patch.accentColor ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Unknown business ${id}`);
    return this.toBusiness(row);
  }

  private toBusiness(row: BusinessRow): Business {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      businessName: row.business_name,
      businessType: row.business_type,
      description: row.description,
      accentColor: row.accent_color,
      createdAt: row.created_at.getTime(),
      updatedAt: row.updated_at.getTime(),
    };
  }
}
