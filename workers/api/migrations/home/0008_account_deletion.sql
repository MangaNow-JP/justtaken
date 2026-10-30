-- Recovered from the deployed D1 schema; original migration was applied on 2026-10-29.
CREATE TABLE user_installations (
  installation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  swept_round INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE user_auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE account_deletions (
  receipt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  requested_at TEXT NOT NULL,
  sweep_after INTEGER NOT NULL,
  round INTEGER NOT NULL DEFAULT 1 CHECK(round IN (1,2)),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE deleted_accounts (
  user_id_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX user_installations_owner ON user_installations(user_id, swept_round);
CREATE INDEX user_auth_sessions_owner ON user_auth_sessions(user_id, purged);
CREATE INDEX account_deletions_retry ON account_deletions(next_attempt);
