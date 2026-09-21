// Core domain types shared across the inventory, order/saga, and warehouse modules.

export type WarehouseId = string;
export type Sku = string;
export type OrderId = string;

export interface ReservationResult {
  ok: boolean;
  reservationId?: string;
  remaining?: number;
  reason?: "INSUFFICIENT_STOCK" | "INVALID_QTY" | "UNKNOWN_SKU";
}

export interface StockRecord {
  sku: Sku;
  warehouseId: WarehouseId;
  available: number;
  reserved: number;
}

export type OrderStatus =
  | "CREATED"
  | "INVENTORY_RESERVED"
  | "PAYMENT_CHARGED"
  | "SHIPPING_SCHEDULED"
  | "CONFIRMED"
  | "COMPENSATING"
  | "CANCELLED"
  | "FAILED";

export interface OrderLine {
  sku: Sku;
  qty: number;
  warehouseId: WarehouseId;
}

export interface Order {
  id: OrderId;
  customerId: string;
  lines: OrderLine[];
  amountCents: number;
  status: OrderStatus;
  history: OrderEvent[];
  createdAt: number;
  updatedAt: number;
  /**
   * The business (see Business below) that placed this order through an
   * authenticated dashboard session, or null for an order created without
   * logging in. This is the tenancy boundary for orders: GET /api/orders and
   * GET /api/orders/:id (src/api/routes/orders.ts) only ever return an
   * authenticated caller's own businessId, or the shared null-businessId
   * pool for anonymous/demo browsing — never another business's orders. See
   * README "Known gaps" for the full rationale (orders are tenant-owned;
   * warehouse inventory, elsewhere, is treated as shared 3PL infrastructure
   * instead of being partitioned the same way).
   */
  businessId: string | null;
}

export interface OrderEvent {
  type: string;
  at: number;
  detail?: Record<string, unknown>;
}

// Injectable failure knobs so tests/demos can force specific saga steps to fail
// deterministically instead of relying on randomness.
export interface FailureInjection {
  failPaymentForOrderIds?: Set<string>;
  failShippingForOrderIds?: Set<string>;
}

// ---------------------------------------------------------------------------
// Business accounts — registration, login, and workspace branding. See
// src/business/businessStore.ts (persistence) and src/api/routes/business.ts
// (HTTP surface: /api/auth/register, /api/auth/login, /api/auth/me,
// /api/business/profile).
// ---------------------------------------------------------------------------

export type BusinessType = "b2c" | "b2b2b" | "b2b" | "other";

export interface Business {
  id: string;
  email: string;
  /** Never sent to the client — see PublicBusiness / toPublic() in routes/business.ts. */
  passwordHash: string;
  businessName: string;
  businessType: BusinessType;
  description: string;
  accentColor: string;
  createdAt: number;
  updatedAt: number;
}

/** What actually goes over the wire — Business minus passwordHash. */
export type PublicBusiness = Omit<Business, "passwordHash">;

export type BusinessProfilePatch = Partial<
  Pick<Business, "businessName" | "businessType" | "description" | "accentColor">
>;
