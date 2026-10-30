-- Recovered from the deployed D1 schema; original migration was applied on 2026-10-29.
CREATE TABLE user_consents (
  user_id TEXT PRIMARY KEY REFERENCES profiles(user_id),
  terms_version TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);
CREATE TABLE user_reports (
  report_id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES profiles(user_id),
  target_user_id TEXT NOT NULL REFERENCES profiles(user_id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('post','user')),
  target_id TEXT NOT NULL,
  post_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('spam','harassment','sexual','child_safety','violence','illegal','privacy','other')),
  details TEXT NOT NULL DEFAULT '' CHECK(length(details)<=2000),
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','under_review','actioned','dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK(reporter_id!=target_user_id),
  CHECK((target_kind='post' AND post_id IS NOT NULL AND post_id=target_id) OR (target_kind='user' AND post_id IS NULL AND target_id=target_user_id)),
  UNIQUE(reporter_id,target_kind,target_id,reason)
);
CREATE INDEX reports_review_queue ON user_reports(status,created_at,report_id);
CREATE INDEX reports_rate ON user_reports(reporter_id,created_at);
CREATE INDEX reports_target ON user_reports(target_user_id,created_at);
