ALTER TABLE cms_ai_jobs
ADD COLUMN conversation_id TEXT;

ALTER TABLE cms_ai_jobs
ADD COLUMN turn_number INTEGER NOT NULL DEFAULT 1
CHECK (turn_number >= 1 AND turn_number <= 30);

ALTER TABLE cms_ai_jobs
ADD COLUMN assistant_message TEXT;

UPDATE cms_ai_jobs
SET conversation_id = id
WHERE conversation_id IS NULL OR conversation_id = '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cms_ai_jobs_conversation_turn
  ON cms_ai_jobs (conversation_id, turn_number);

CREATE INDEX IF NOT EXISTS idx_cms_ai_jobs_requester_conversation
  ON cms_ai_jobs (requested_by, conversation_id, created_at ASC);
