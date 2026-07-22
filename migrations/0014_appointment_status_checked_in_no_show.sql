-- Extends the appointment status vocabulary with checked_in and no_show
-- (E-Check-In / no-show handling). appointments.status has never had a
-- DB-level CHECK constraint (unlike complaints/audit_log/earnings_ledger,
-- which all use one) — since this migration touches the column for the
-- first time, add one now rather than leave it implicit.
--
--   psql "$DATABASE_URL" -f migrations/0014_appointment_status_checked_in_no_show.sql

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN (
    'pending_approval',
    'pending_payment',
    'upcoming',
    'checked_in',
    'declined',
    'cancelled',
    'no_show',
    'past'
  ));
