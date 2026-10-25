CREATE TABLE proof_anchors (
  proof_id TEXT PRIMARY KEY REFERENCES capture_proofs(proof_id),
  certificate_digest TEXT NOT NULL,
  nonce TEXT NOT NULL,
  timestamp_response TEXT,
  log_request TEXT,
  anchors TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  completed_at TEXT
);
CREATE INDEX proof_anchors_retry ON proof_anchors(next_attempt) WHERE anchors IS NULL;
