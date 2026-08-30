ALTER TABLE cms_ai_jobs
ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'medium'
CHECK (reasoning_effort IN ('low', 'medium', 'high'));
