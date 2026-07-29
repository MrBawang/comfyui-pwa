CREATE TABLE r2_browser_auth_attempts (
  owner_email TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX r2_browser_auth_locked ON r2_browser_auth_attempts(locked_until);
