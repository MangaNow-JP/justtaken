CREATE TABLE early_access_registrations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK(platform IN ('ios','android','both')),
  consent_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  cancellation_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX early_access_expiry ON early_access_registrations(expires_at);
