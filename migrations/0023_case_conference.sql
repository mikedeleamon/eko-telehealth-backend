-- Proxy case-conference sessions (BRD 1.2 "Proxies") — a paid booking with
-- one of a dependent's treating doctors to discuss overall treatment.
-- Reuses the entire existing appointment/payment pipeline, same pattern as
-- migrations/0022_peer_review.sql.
--
--   psql "$DATABASE_URL" -f migrations/0023_case_conference.sql

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_case_conference boolean NOT NULL DEFAULT false;
