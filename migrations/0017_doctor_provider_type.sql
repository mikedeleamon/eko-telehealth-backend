-- Batch 3 Phase 2 — Therapist/Nurse as real bookable providers. They ride the
-- existing `doctors` table (same availability/appointments/earnings/chat
-- machinery) via this discriminator column rather than a new table — see the
-- Batch 3 scoping memo. Defaults every existing row to 'Doctor', which is
-- exactly what they all are today.
--
--   psql "$DATABASE_URL" -f migrations/0017_doctor_provider_type.sql

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS provider_type text NOT NULL DEFAULT 'Doctor';

ALTER TABLE doctors DROP CONSTRAINT IF EXISTS doctors_provider_type_check;
ALTER TABLE doctors ADD CONSTRAINT doctors_provider_type_check CHECK (provider_type IN ('Doctor', 'Nurse', 'Therapist'));
