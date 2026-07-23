-- Peer Reviews (paid 2nd opinion) — BRD 1.4, previously a fully dead mobile
-- screen with no backend at all. Reuses the entire existing appointment/
-- payment pipeline; this flag is the only new thing, so the UI can frame a
-- booking as a 2nd-opinion request instead of an ordinary visit.
--
--   psql "$DATABASE_URL" -f migrations/0022_peer_review.sql

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_peer_review boolean NOT NULL DEFAULT false;
