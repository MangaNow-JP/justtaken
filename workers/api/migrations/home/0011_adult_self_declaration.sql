-- Recovered from production schema.
ALTER TABLE user_consents ADD COLUMN age_confirmation_version TEXT;
ALTER TABLE user_consents ADD COLUMN age_confirmed_at TEXT;
