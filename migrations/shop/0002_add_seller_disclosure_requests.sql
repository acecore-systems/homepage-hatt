CREATE TABLE IF NOT EXISTS shop_disclosure_schema_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO shop_disclosure_schema_metadata (id, version)
VALUES (1, 1);

CREATE TABLE IF NOT EXISTS shop_disclosure_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  request_count INTEGER NOT NULL DEFAULT 1 CHECK (request_count > 0),
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shop_disclosure_rate_limits_expires
  ON shop_disclosure_rate_limits (expires_at);

CREATE TABLE IF NOT EXISTS shop_disclosure_requests (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('processing', 'sent', 'failed', 'delivery_unknown')
  ),
  processing_token TEXT,
  email_message_id TEXT,
  failure_code TEXT,
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shop_disclosure_requests_status_updated
  ON shop_disclosure_requests (status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_disclosure_requests_email_unresolved
  ON shop_disclosure_requests (email_hash)
  WHERE status IN ('processing', 'delivery_unknown');

CREATE INDEX IF NOT EXISTS idx_shop_disclosure_requests_expires
  ON shop_disclosure_requests (expires_at);
