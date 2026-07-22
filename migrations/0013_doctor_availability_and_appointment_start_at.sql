-- Scheduling foundation: a doctor's recurring weekly working hours, and a
-- real start-time column on appointments to replace the free-text date/time
-- the client used to send with no validation or collision checking.
--
--   psql "$DATABASE_URL" -f migrations/0013_doctor_availability_and_appointment_start_at.sql

CREATE TABLE IF NOT EXISTS doctor_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  weekday integer NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute > start_minute AND end_minute <= 1440),
  slot_minutes integer NOT NULL DEFAULT 60 CHECK (slot_minutes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doctor_availability_doctor_weekday_idx
  ON doctor_availability (doctor_id, weekday);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS start_at timestamptz;

-- Real collision guard. Partial (not a plain unique index) so a cancelled or
-- declined appointment doesn't permanently occupy its slot — only rows still
-- "holding" the doctor's time (upcoming, checked_in, no_show, past, or a
-- fresh pending_* request) block a rebooking. NULL start_at (legacy rows)
-- never conflicts with anything, by ordinary unique-index NULL semantics.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_doctor_start_at_idx
  ON appointments (doctor_id, start_at)
  WHERE status NOT IN ('cancelled', 'declined');

-- Day-one backfill: without this, every existing doctor shows zero available
-- slots the instant this ships, since doctor_availability starts empty.
-- Mon-Fri, 9:00-17:00 (540-1020 minutes), 60-minute slots. Idempotent — skips
-- any doctor who already has at least one row (e.g. re-running this file, or
-- a doctor who set their own hours before this backfill ran).
INSERT INTO doctor_availability (doctor_id, weekday, start_minute, end_minute, slot_minutes)
SELECT d.id, wd, 540, 1020, 60
FROM doctors d, generate_series(1, 5) AS wd
WHERE NOT EXISTS (SELECT 1 FROM doctor_availability WHERE doctor_id = d.id);
