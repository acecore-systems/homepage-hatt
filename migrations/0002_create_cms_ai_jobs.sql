CREATE TABLE IF NOT EXISTS cms_ai_jobs (
  id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  target_url TEXT NOT NULL,
  instruction TEXT NOT NULL,
  attachment_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  summary TEXT,
  clarification TEXT,
  pr_url TEXT,
  deployment_url TEXT,
  changed_paths_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cms_ai_jobs_requester_created
  ON cms_ai_jobs (requested_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cms_ai_jobs_status_updated
  ON cms_ai_jobs (status, updated_at DESC);
