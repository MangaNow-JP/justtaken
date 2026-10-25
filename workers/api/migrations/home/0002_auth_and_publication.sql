ALTER TABLE profiles ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN installation_id TEXT;
ALTER TABLE posts ADD COLUMN moderation TEXT NOT NULL DEFAULT 'PENDING' CHECK(moderation IN ('PENDING','ALLOWED','BLOCKED'));
ALTER TABLE posts ADD COLUMN server_verified_at TEXT;
CREATE INDEX posts_feed ON posts(state, published_at DESC, post_id DESC);
CREATE TABLE quota_reservations (
  capture_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(user_id),
  bytes INTEGER NOT NULL CHECK(bytes > 0), expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'RESERVED' CHECK(state IN ('RESERVED','USED','RELEASED'))
);
CREATE TABLE blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, PRIMARY KEY(blocker_id, blocked_id));
CREATE TABLE moderation_decisions (capture_id TEXT PRIMARY KEY, decision TEXT NOT NULL CHECK(decision IN ('ALLOWED','BLOCKED')), reviewer_id TEXT NOT NULL, decided_at TEXT NOT NULL);
CREATE TRIGGER reserve_quota AFTER INSERT ON quota_reservations WHEN NEW.state='RESERVED' BEGIN
  UPDATE quota_accounts SET reserved_bytes=reserved_bytes+NEW.bytes WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER finish_reservation AFTER UPDATE OF state ON quota_reservations WHEN OLD.state='RESERVED' AND NEW.state!='RESERVED' BEGIN
  UPDATE quota_accounts SET reserved_bytes=reserved_bytes-OLD.bytes,used_bytes=used_bytes+CASE WHEN NEW.state='USED' THEN NEW.bytes ELSE 0 END WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER release_used AFTER UPDATE OF state ON quota_reservations WHEN OLD.state='USED' AND NEW.state='RELEASED' BEGIN
  UPDATE quota_accounts SET used_bytes=used_bytes-OLD.bytes WHERE user_id=NEW.user_id;
END;
