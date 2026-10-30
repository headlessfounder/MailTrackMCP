-- GrokBotTrack schema — multi-user from day one
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  api_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  -- Per-user engagement webhook; falls back to WEBHOOK_URL when unset.
  webhook_url TEXT,
  webhook_secret TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  recipient TEXT NOT NULL,
  subject TEXT,
  campaign TEXT,
  agent_source TEXT,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  original_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  link_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('open','click')),
  ts TEXT NOT NULL,
  ua TEXT,
  ip TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  classification TEXT NOT NULL DEFAULT 'human'
);

CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_links_message ON links(message_id);

-- One-time magic-link login tokens (Phase 5)
CREATE TABLE IF NOT EXISTS login_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_login_tokens_user ON login_tokens(user_id);
