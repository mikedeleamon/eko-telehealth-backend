-- Government-ID verification for patients (SOW 1.9) — previously only
-- providers had a gov-ID check (provider_applications.check_gov_id).
-- Not a booking gate, purely a trust signal: submit is self-service, review
-- is admin-only.
--
--   psql "$DATABASE_URL" -f migrations/0020_gov_id_verification.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS gov_id_status text NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS gov_id_key text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gov_id_file_name text;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gov_id_status_check;
ALTER TABLE users ADD CONSTRAINT users_gov_id_status_check CHECK (gov_id_status IN ('none', 'pending', 'verified', 'rejected'));
