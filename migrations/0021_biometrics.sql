-- Real My Health vitals (patient's own view + doctor's roster view were
-- both previously hardcoded/mock — see the requirements-traceability
-- rescan). One row per patient, upserted — not a history table, since
-- there's no chart/trend UI to consume a time series.
--
--   psql "$DATABASE_URL" -f migrations/0021_biometrics.sql

CREATE TABLE IF NOT EXISTS biometrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL UNIQUE,
  blood_pressure text,
  heart_rate text,
  temperature text,
  weight text,
  height text,
  bmi text,
  blood_type text,
  recorded_at text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
