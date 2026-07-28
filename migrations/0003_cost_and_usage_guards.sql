CREATE TABLE cost_quotes (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  file_bytes INTEGER NOT NULL,
  batch_count INTEGER NOT NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  max_duration_seconds INTEGER NOT NULL,
  estimated_max_usd REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  approval_token_hash TEXT,
  quote_expires_at INTEGER NOT NULL,
  approval_expires_at INTEGER,
  approved_at INTEGER,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX cost_quotes_owner_created ON cost_quotes(owner_email, created_at DESC);

CREATE TABLE modal_submissions (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  quote_id TEXT REFERENCES cost_quotes(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitting', 'completed', 'rejected', 'needs-human')),
  response_status INTEGER,
  response_content_type TEXT,
  response_body TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_email, action, idempotency_key)
);
CREATE INDEX modal_submissions_owner_created ON modal_submissions(owner_email, created_at DESC);

CREATE TABLE workflow_cache (
  workflow_id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, owner_email)
);
CREATE INDEX workflow_cache_owner_updated ON workflow_cache(owner_email, updated_at DESC);

CREATE TABLE r2_usage_monthly (
  usage_month TEXT PRIMARY KEY,
  class_a INTEGER NOT NULL DEFAULT 0,
  class_b INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

ALTER TABLE ai_usage_daily ADD COLUMN reserved_neurons REAL NOT NULL DEFAULT 0;
ALTER TABLE batches ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX batches_idempotency_key ON batches(idempotency_key) WHERE idempotency_key IS NOT NULL;
