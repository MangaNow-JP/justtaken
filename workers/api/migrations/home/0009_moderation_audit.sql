-- Recovered from the deployed D1 schema; original migration was applied on 2026-10-29.
CREATE TABLE moderation_audit (
  audit_id TEXT PRIMARY KEY,
  capture_id TEXT,
  report_id TEXT,
  decision TEXT CHECK(decision IN ('ALLOWED','BLOCKED')),
  report_status TEXT CHECK(report_status IN ('under_review','actioned','dismissed')),
  reviewer_id TEXT NOT NULL CHECK(length(reviewer_id) BETWEEN 1 AND 200),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  original_sha256 TEXT,
  proof_sha256 TEXT,
  decided_at TEXT NOT NULL,
  CHECK((decision IS NOT NULL AND capture_id IS NOT NULL AND original_sha256 IS NOT NULL AND proof_sha256 IS NOT NULL AND length(original_sha256)=64 AND length(proof_sha256)=64)
    OR (decision IS NULL AND capture_id IS NULL AND report_id IS NOT NULL AND report_status IN ('under_review','dismissed'))),
  CHECK((report_id IS NULL AND report_status IS NULL) OR (report_id IS NOT NULL AND report_status IS NOT NULL))
);
CREATE INDEX moderation_audit_capture ON moderation_audit(capture_id,decided_at);
CREATE INDEX moderation_audit_report ON moderation_audit(report_id,decided_at);
