-- Production order persistence (PgOrderStore implements orders/orderStore.ts's
-- OrderStore interface against this schema). Not required for local dev —
-- InMemoryOrderStore is used by default and by the test suite.

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  customer_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, sku, warehouse_id)
);

CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
