-- Recovered support fields already applied in production.
ALTER TABLE account_deletions ADD COLUMN support_case_ref TEXT;
ALTER TABLE account_deletions ADD COLUMN support_case_hash TEXT;
ALTER TABLE account_deletions ADD COLUMN support_operator_id TEXT;
ALTER TABLE account_deletions ADD COLUMN support_verification_method TEXT;
ALTER TABLE account_deletions ADD COLUMN support_user_id_hash TEXT;
ALTER TABLE account_deletions ADD COLUMN support_profile_created_at TEXT;
ALTER TABLE account_deletions ADD COLUMN support_session_epoch INTEGER;
ALTER TABLE account_deletions ADD COLUMN support_expected_status TEXT;
ALTER TABLE account_deletions ADD COLUMN support_planned_at INTEGER;
ALTER TABLE account_deletions ADD COLUMN support_plan_expires_at INTEGER;
