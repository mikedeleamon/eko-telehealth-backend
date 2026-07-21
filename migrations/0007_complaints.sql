-- Complaint / support-issue tracking (task 2.1) — a trackable alternative to
-- the static "Contact Us" text on AboutUsScreen, with a real admin-managed
-- lifecycle (pending → resolved/dismissed) mirroring the reviews moderation
-- pattern.
--
-- Idempotent — safe to run repeatedly and safe on a database freshly created
-- from the current schema.ts.
--
--   psql "$DATABASE_URL" -f migrations/0007_complaints.sql

CREATE TABLE IF NOT EXISTS complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  author_name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('Patient', 'Doctor')),
  category text NOT NULL CHECK (category IN ('billing', 'appointment', 'provider', 'technical', 'other')),
  subject text NOT NULL,
  description text NOT NULL,
  appointment_id uuid REFERENCES appointments(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolution_note text,
  submitted_at text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
