CREATE TABLE IF NOT EXISTS shop_orders (
  id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  customer_email TEXT,
  customer_name TEXT,
  currency TEXT NOT NULL DEFAULT 'JPY',
  subtotal_jpy INTEGER NOT NULL,
  shipping_jpy INTEGER NOT NULL DEFAULT 0,
  tax_jpy INTEGER NOT NULL DEFAULT 0,
  total_jpy INTEGER NOT NULL,
  payment_status TEXT NOT NULL,
  fulfillment_status TEXT NOT NULL,
  shipping_address_json TEXT,
  tracking_number TEXT,
  manual_note TEXT,
  refund_note TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT,
  canceled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_shop_orders_created
  ON shop_orders (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shop_orders_payment
  ON shop_orders (payment_status, fulfillment_status);

CREATE TABLE IF NOT EXISTS shop_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  fulfillment_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price_jpy INTEGER NOT NULL,
  total_price_jpy INTEGER NOT NULL,
  r2_object_key TEXT,
  shipping_profile_id TEXT,
  item_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES shop_orders (id)
);

CREATE INDEX IF NOT EXISTS idx_shop_order_items_order
  ON shop_order_items (order_id, created_at);

CREATE TABLE IF NOT EXISTS shop_stock (
  product_slug TEXT PRIMARY KEY,
  available INTEGER NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_stock_reservations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_slug TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  stripe_session_id TEXT,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES shop_orders (id)
);

CREATE INDEX IF NOT EXISTS idx_shop_stock_reservations_order
  ON shop_stock_reservations (order_id, status);

CREATE INDEX IF NOT EXISTS idx_shop_stock_reservations_expiry
  ON shop_stock_reservations (status, expires_at);

CREATE TABLE IF NOT EXISTS shop_download_tokens (
  token_hash TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  product_slug TEXT NOT NULL,
  r2_object_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 5,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (order_id) REFERENCES shop_orders (id),
  FOREIGN KEY (order_item_id) REFERENCES shop_order_items (id)
);

CREATE INDEX IF NOT EXISTS idx_shop_download_tokens_order
  ON shop_download_tokens (order_id, order_item_id, expires_at);

CREATE TABLE IF NOT EXISTS shop_fulfillment_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES shop_orders (id)
);

CREATE INDEX IF NOT EXISTS idx_shop_fulfillment_events_order
  ON shop_fulfillment_events (order_id, created_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processing_status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_message TEXT
);
