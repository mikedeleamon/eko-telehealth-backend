-- Seven-feature batch (July 20 2026): schema deltas for the mobile feature work.
--
-- Covers: App Store-style reviews (title/verified/comments), Doctor documents &
-- certifications, patient/practice prescriptions, labs, structured medical
-- notes (primary/secondary diagnosis + draft status + amendments), and a
-- roster_patients ↔ users link so doctor-written records surface in a linked
-- patient's own self-view.
--
-- Fully idempotent: every statement uses IF NOT EXISTS / IF EXISTS guards, so
-- it is safe to run repeatedly and safe on a database freshly created from the
-- current schema.ts. `npm run db:push` HANGS on interactive prompts in this
-- project (no TTY under `railway run`), so apply this SQL directly instead:
--
--   psql "$DATABASE_URL" -f migrations/0002_seven_feature_batch.sql
-- or paste into the Supabase SQL editor, or:
--   railway run psql "$DATABASE_URL" -f migrations/0002_seven_feature_batch.sql
--
-- After applying, re-run the seed if you want the new demo rows:
--   railway run npm run db:seed

-- ── Roster ↔ patient-account linking ────────────────────────────────────────
-- Doctor-authored records (prescriptions, labs, medical notes) are keyed by a
-- "patient id" that, for doctor-written records, was always the
-- roster_patients row id — a space with NO relationship to users.id. A
-- patient with a real account therefore never saw doctor-written records in
-- their own self-view (/me/prescriptions, /me/labs). This adds a nullable
-- link so the backend can resolve a roster entry to the real account when one
-- exists (see resolvePatientId in routes/practice.ts), while unlinked entries
-- (walk-ins, demo-only names) keep working exactly as before.
ALTER TABLE roster_patients ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id);

-- One-time backfill: link a roster entry to a patient account when the names
-- match (case-insensitive) AND that account actually has an appointment with
-- the same doctor — the appointment is the real-world proof the two rows are
-- the same person. Ambiguous (multiple candidates) or no match stays
-- unlinked rather than guessing wrong; the app's resolvePatientId will retry
-- this same match lazily for anything this backfill leaves unlinked.
WITH candidates AS (
  SELECT rp.id AS roster_id, u.id AS user_id,
         count(DISTINCT u.id) OVER (PARTITION BY rp.id) AS match_count
  FROM roster_patients rp
  JOIN appointments a ON a.doctor_id = rp.doctor_id
  JOIN users u ON u.id = a.patient_id
  WHERE rp.user_id IS NULL
    AND lower(trim(rp.name)) = lower(trim(u.first_name || ' ' || u.last_name))
  GROUP BY rp.id, u.id
)
UPDATE roster_patients rp
SET user_id = c.user_id
FROM candidates c
WHERE rp.id = c.roster_id AND c.match_count = 1;

-- ── #3 Reviews: App Store fields ────────────────────────────────────────────
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS comments_count integer NOT NULL DEFAULT 0;

-- ── #1 Documents & Certifications (Doctor) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other',
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  storage_key text,
  uploaded_at text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents(user_id);

-- ── #6 Prescriptions ────────────────────────────────────────────────────────
-- patient_id holds a roster-patient id (doctor-written) OR a user id (patient
-- self-view) — different id spaces, so no FK.
CREATE TABLE IF NOT EXISTS prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  drug text NOT NULL,
  strength text NOT NULL,
  form text NOT NULL,
  route text NOT NULL,
  frequency text NOT NULL,
  duration text NOT NULL,
  quantity text NOT NULL,
  refills text NOT NULL,
  instructions text,
  status text NOT NULL DEFAULT 'active',
  doctor_id uuid REFERENCES doctors(id),
  doctor_name text NOT NULL,
  date_prescribed text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prescriptions_patient_id_idx ON prescriptions(patient_id);

-- ── #4 Labs ─────────────────────────────────────────────────────────────────
-- patient_id: roster-patient id (doctor-entered) or user id (patient self), no FK.
CREATE TABLE IF NOT EXISTS labs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  test_name text NOT NULL,
  loinc_code text,
  specimen text NOT NULL,
  value text NOT NULL,
  unit text,
  reference_range text,
  flag text NOT NULL DEFAULT 'normal',
  status text NOT NULL DEFAULT 'resulted',
  ordered_by text,
  performing_lab text,
  collected_date text NOT NULL,
  resulted_date text,
  notes text,
  attachment_key text,
  attachment_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS labs_patient_id_idx ON labs(patient_id);

-- ── #5 Medical notes (SOAP records + diagnoses + drafts + amendments) ────────
-- patient_id: roster-patient id (no FK). secondary_diagnoses/amendments are jsonb.
CREATE TABLE IF NOT EXISTS medical_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  appointment_id text NOT NULL,
  date text NOT NULL,
  visit_type text,
  doctor_id uuid REFERENCES doctors(id),
  doctor_name text NOT NULL,
  doctor_specialty text NOT NULL DEFAULT '',
  reason text NOT NULL,
  subjective text NOT NULL DEFAULT '',
  objective text NOT NULL DEFAULT '',
  assessment text NOT NULL DEFAULT '',
  primary_diagnosis text,
  secondary_diagnoses jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'final',
  amendments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE INDEX IF NOT EXISTS medical_notes_patient_id_idx ON medical_notes(patient_id);
