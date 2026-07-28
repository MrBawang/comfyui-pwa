PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_word TEXT NOT NULL,
  target TEXT NOT NULL,
  reference_key TEXT NOT NULL,
  reference_filename TEXT NOT NULL,
  reference_media_type TEXT NOT NULL,
  reference_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_owner_updated ON projects(owner_email, updated_at DESC);

CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  workflow_revision_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'idle',
  analysis_message TEXT,
  analysis_progress INTEGER,
  report_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX batches_project_created ON batches(project_id, created_at DESC);

CREATE TABLE batch_views (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  horizontal_angle REAL NOT NULL,
  vertical_angle REAL NOT NULL,
  zoom REAL NOT NULL,
  bucket TEXT NOT NULL,
  position INTEGER NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX batch_views_batch_position ON batch_views(batch_id, position);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 10,
  workflow_id TEXT NOT NULL,
  workflow_revision_id TEXT,
  workflow_name TEXT,
  form_json TEXT NOT NULL,
  files_json TEXT NOT NULL,
  idempotency_key TEXT,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
  view_id TEXT REFERENCES batch_views(id) ON DELETE SET NULL,
  modal_job_id TEXT,
  message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX runs_owner_idempotency ON runs(owner_email, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX runs_queue ON runs(status, priority DESC, created_at);
CREATE INDEX runs_owner_created ON runs(owner_email, created_at DESC);

CREATE TABLE run_outputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX run_outputs_run_index ON run_outputs(run_id, output_index);
CREATE INDEX run_outputs_run ON run_outputs(run_id, output_index);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  view_id TEXT NOT NULL REFERENCES batch_views(id) ON DELETE CASCADE,
  run_output_id TEXT NOT NULL REFERENCES run_outputs(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  quality_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX candidates_batch ON candidates(batch_id, created_at);
CREATE UNIQUE INDEX candidates_run_output ON candidates(run_output_id);

CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL UNIQUE REFERENCES batches(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  agent_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_tasks_claim ON agent_tasks(status, created_at);

CREATE TABLE system_prompt_presets (
  id TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  workflow_id TEXT,
  content TEXT NOT NULL,
  version INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX system_prompts_owner_scope ON system_prompt_presets(owner_email, scope, workflow_id, updated_at DESC);

CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  workflow_id TEXT,
  workflow_revision_id TEXT,
  target_field_name TEXT,
  system_prompt_preset_id TEXT,
  system_prompt_version INTEGER,
  system_prompt_override TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_threads_owner_updated ON chat_threads(owner_email, updated_at DESC);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  provider_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX chat_messages_thread_created ON chat_messages(thread_id, created_at);

CREATE TABLE storage_objects (
  object_key TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  category TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX storage_objects_owner ON storage_objects(owner_email, category);

CREATE TABLE migration_records (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source, source_id)
);

CREATE TABLE ai_usage_daily (
  owner_email TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_neurons REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_email, usage_date, provider_id)
);
