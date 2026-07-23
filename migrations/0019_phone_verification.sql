-- Patient phone verification at signup. New accounts start unverified
-- (routes/auth.ts's promotePendingSignup explicitly sets phone_verified:
-- false) and go through a mandatory SMS-OTP step right after email
-- verification. The column defaults true so it never retroactively affects
-- existing accounts or any other account-creation path (seeds, admin) —
-- Postgres backfills a constant default onto every existing row as part of
-- the ALTER, so no separate UPDATE is needed.
--
--   psql "$DATABASE_URL" -f migrations/0019_phone_verification.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT true;
