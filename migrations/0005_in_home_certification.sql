-- In-home care certification (task 2.3): an admin-managed privilege on the
-- doctors row. A provider can only be booked for a Home Visit once this is
-- on — enforced server-side in routes/appointments.ts, not just hidden
-- client-side. Defaults false: every existing/new provider starts
-- uncertified until an admin explicitly turns it on.
--
-- Idempotent — safe to run repeatedly and safe on a database freshly
-- created from the current schema.ts.
--
--   psql "$DATABASE_URL" -f migrations/0005_in_home_certification.sql

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS can_provide_in_home boolean NOT NULL DEFAULT false;
