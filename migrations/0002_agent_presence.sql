CREATE TABLE agent_presence (
  agent_id TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX agent_presence_last_seen ON agent_presence(last_seen_at DESC);
