ALTER TABLE profiles ADD COLUMN auth_provider TEXT CHECK(auth_provider IN ('apple','google'));
CREATE TABLE provider_credentials (
  user_id TEXT PRIMARY KEY REFERENCES profiles(user_id), provider TEXT NOT NULL,
  token_ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE account_deletion_receipts (
  receipt_hash TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETE')),
  requested_at INTEGER NOT NULL, completed_at INTEGER,
  provider_revocation TEXT NOT NULL DEFAULT 'PENDING'
);
CREATE TABLE review_audit (
  event_id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL, post_id TEXT NOT NULL,
  action TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE account_review_audit (
  event_id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
  report_id TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL
);
