-- Initial user-home schema. NOT applied remotely. Four physical home shards and
-- a separate directory are provisioned only after the auth/capture PoC passes.
PRAGMA foreign_keys = ON;
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY, bucket_id INTEGER NOT NULL CHECK(bucket_id BETWEEN 0 AND 255),
  display_name TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 1 CHECK(is_private IN (0,1)),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','DELETED')),
  acl_revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE posts (
  post_id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES profiles(user_id),
  bucket_id INTEGER NOT NULL CHECK(bucket_id BETWEEN 0 AND 255), capture_id TEXT NOT NULL UNIQUE,
  caption TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'followers' CHECK(visibility IN ('public','followers','private')),
  state TEXT NOT NULL DEFAULT 'PROCESSING' CHECK(state IN ('DRAFT','PROCESSING','READY','PUBLISHED','HIDDEN','DELETED')),
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, published_at TEXT
);
CREATE INDEX posts_author_cursor ON posts(bucket_id, author_id, published_at DESC, post_id DESC);
CREATE TABLE capture_projection (
  capture_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL, receipt_key TEXT, server_verified_at TEXT
);
CREATE TABLE followers (
  target_id TEXT NOT NULL REFERENCES profiles(user_id), follower_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','APPROVED','REMOVED')), revision INTEGER NOT NULL,
  PRIMARY KEY(target_id, follower_id)
);
CREATE TABLE quota_accounts (
  user_id TEXT PRIMARY KEY REFERENCES profiles(user_id), limit_bytes INTEGER NOT NULL DEFAULT 200000000,
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes >= 0), reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
  revision INTEGER NOT NULL DEFAULT 1, CHECK(used_bytes + reserved_bytes <= limit_bytes)
);
CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, processed_at TEXT NOT NULL);
CREATE TABLE outbox (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT);
