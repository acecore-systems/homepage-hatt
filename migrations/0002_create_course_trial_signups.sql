CREATE TABLE IF NOT EXISTS course_trial_signups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  goal TEXT NOT NULL,
  preferred_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  client_hash TEXT NOT NULL,
  user_agent_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_course_trial_signups_created
  ON course_trial_signups (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_course_trial_signups_client_created
  ON course_trial_signups (client_hash, created_at);

CREATE TABLE IF NOT EXISTS course_push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  endpoint_hash TEXT NOT NULL,
  subscription_json TEXT NOT NULL,
  device_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  disabled_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_course_push_subscriptions_active
  ON course_push_subscriptions (disabled_at, last_seen_at);
