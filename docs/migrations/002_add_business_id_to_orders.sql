-- Migration for an EXISTING Postgres volume created before multi-tenant
-- order scoping was added (see src/types.ts's Order.businessId,
-- src/orders/pgOrderStore.ts).
--
-- docs/schema.sql already defines `business_id` on a fresh `orders` table —
-- this file is only needed if your `docker compose` Postgres volume was
-- initialized before that column existed, since
-- docker-entrypoint-initdb.d/schema.sql only runs once, on first boot of an
-- empty data directory.
--
-- Apply with, e.g.:
--   docker compose exec -T postgres psql -U app -d supply_chain \
--     < docs/migrations/002_add_business_id_to_orders.sql
-- or, if you don't mind losing local demo data instead:
--   docker compose down -v postgres && docker compose up postgres

ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_id UUID;
CREATE INDEX IF NOT EXISTS idx_orders_business_id ON orders (business_id);
