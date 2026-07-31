CREATE TABLE modal_chat_jobs (
  operation_id TEXT PRIMARY KEY REFERENCES modal_submissions(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'submitting', 'warming', 'generating', 'completed', 'failed', 'needs-human', 'cancelled')),
  modal_job_id TEXT,
  message TEXT,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX modal_chat_jobs_queue ON modal_chat_jobs(status, created_at);
CREATE INDEX modal_chat_jobs_owner ON modal_chat_jobs(owner_email, created_at DESC);
CREATE UNIQUE INDEX modal_chat_jobs_thread_active ON modal_chat_jobs(thread_id)
  WHERE status IN ('queued', 'submitting', 'warming', 'generating', 'needs-human');
