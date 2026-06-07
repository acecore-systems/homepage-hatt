CREATE TABLE IF NOT EXISTS blog_comments (
  id TEXT PRIMARY KEY,
  post_slug TEXT NOT NULL,
  locale TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  user_agent_hash TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_blog_comments_post_created
  ON blog_comments (post_slug, deleted_at, created_at);

CREATE INDEX IF NOT EXISTS idx_blog_comments_client_created
  ON blog_comments (client_hash, created_at);

CREATE INDEX IF NOT EXISTS idx_blog_comments_duplicate
  ON blog_comments (post_slug, body_hash, created_at);
