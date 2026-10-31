-- Preserve all existing reports while adding a distinct comment target. Audit tables
-- refer to immutable report IDs (not a foreign key to this table).
-- This legacy audit trigger exists in production. Restore its exact behavior after
-- the table swap; otherwise SQLite rejects ALTER TABLE while its target is absent.
DROP TRIGGER IF EXISTS moderation_audit_apply;
CREATE TABLE user_reports_next (
  report_id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES profiles(user_id),
  target_user_id TEXT NOT NULL REFERENCES profiles(user_id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('post','user','comment')),
  target_id TEXT NOT NULL,
  post_id TEXT,
  comment_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('spam','harassment','sexual','child_safety','violence','illegal','privacy','other')),
  details TEXT NOT NULL DEFAULT '' CHECK(length(details)<=2000),
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','under_review','actioned','dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK(reporter_id!=target_user_id),
  CHECK((target_kind='post' AND post_id=target_id AND post_id IS NOT NULL AND comment_id IS NULL)
    OR (target_kind='user' AND post_id IS NULL AND comment_id IS NULL AND target_id=target_user_id)
    OR (target_kind='comment' AND post_id IS NULL AND comment_id IS NOT NULL AND comment_id=target_id)),
  UNIQUE(reporter_id,target_kind,target_id,reason)
);
INSERT INTO user_reports_next(report_id,reporter_id,target_user_id,target_kind,target_id,post_id,reason,details,status,created_at,resolved_at)
  SELECT report_id,reporter_id,target_user_id,target_kind,target_id,post_id,reason,details,status,created_at,resolved_at FROM user_reports;
DROP TABLE user_reports;
ALTER TABLE user_reports_next RENAME TO user_reports;
CREATE INDEX reports_review_queue ON user_reports(status,created_at,report_id);
CREATE INDEX reports_rate ON user_reports(reporter_id,created_at);
CREATE INDEX reports_target ON user_reports(target_user_id,created_at);
CREATE TRIGGER moderation_audit_apply AFTER INSERT ON moderation_audit BEGIN
  INSERT INTO moderation_decisions(capture_id,decision,reviewer_id,decided_at)
    SELECT NEW.capture_id,NEW.decision,NEW.reviewer_id,NEW.decided_at WHERE NEW.decision IS NOT NULL
    ON CONFLICT(capture_id) DO UPDATE SET decision=excluded.decision,reviewer_id=excluded.reviewer_id,decided_at=excluded.decided_at;
  UPDATE posts SET
    state=CASE WHEN NEW.decision='BLOCKED' THEN 'HIDDEN' WHEN state='HIDDEN' THEN 'PROCESSING' ELSE state END,
    moderation=NEW.decision,revision=revision+1
    WHERE capture_id=NEW.capture_id AND NEW.decision IS NOT NULL AND state!='DELETED'
      AND EXISTS(SELECT 1 FROM profiles WHERE profiles.user_id=posts.author_id AND profiles.status='ACTIVE');
  UPDATE proof_shares SET revoked_at=COALESCE(revoked_at,CAST(strftime('%s',NEW.decided_at) AS INTEGER)*1000)
    WHERE NEW.decision='BLOCKED' AND proof_id IN(SELECT proof_id FROM capture_proofs WHERE capture_id=NEW.capture_id);
  UPDATE user_reports SET status=NEW.report_status,
    resolved_at=CASE WHEN NEW.report_status IN ('actioned','dismissed') THEN NEW.decided_at ELSE NULL END
    WHERE report_id=NEW.report_id;
END;
