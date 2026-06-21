ALTER TABLE shop_orders
ADD COLUMN stripe_connected_account_id TEXT;

ALTER TABLE shop_orders
ADD COLUMN platform_fee_jpy INTEGER NOT NULL DEFAULT 0;

ALTER TABLE shop_orders
ADD COLUMN platform_fee_basis_points INTEGER NOT NULL DEFAULT 0;

ALTER TABLE shop_orders
ADD COLUMN platform_fee_fixed_jpy INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_shop_orders_connected_account
  ON shop_orders (stripe_connected_account_id, created_at DESC);
