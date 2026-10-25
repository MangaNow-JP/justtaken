-- Proof vault is independent of posts; tokens are never stored in plaintext.
ALTER TABLE profiles ADD COLUMN proof_creator_id TEXT;
CREATE UNIQUE INDEX profiles_proof_creator ON profiles(proof_creator_id);
CREATE TABLE capture_proofs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  proof_id TEXT NOT NULL UNIQUE,
  capture_id TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES profiles(user_id),
  certificate TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX capture_proofs_owner ON capture_proofs(owner_id, sequence DESC);
CREATE TABLE proof_shares (
  share_id TEXT PRIMARY KEY,
  proof_id TEXT NOT NULL REFERENCES capture_proofs(proof_id),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX proof_shares_proof ON proof_shares(proof_id, expires_at);
