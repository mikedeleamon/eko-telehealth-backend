-- Batch 3 Phase 3 — Pharmacy as a real directory entity (admin-managed, no
-- self-service login/dispense UI this batch). Created the same way Doctor/
-- Nurse/Therapist entities are: approving a provider_applications row of
-- type 'Pharmacy' (see routes/admin.ts's createEntityForApproval).
--
--   psql "$DATABASE_URL" -f migrations/0018_pharmacy_directory.sql

CREATE TABLE IF NOT EXISTS pharmacies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id),
  name text NOT NULL,
  address text NOT NULL,
  fax text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- pharmacy_preferences can now reference a real directory pharmacy
-- (in-network) instead of only free text — address/fax become the
-- out-of-network fallback, so they're no longer always required.
ALTER TABLE pharmacy_preferences ADD COLUMN IF NOT EXISTS pharmacy_id uuid REFERENCES pharmacies(id);
ALTER TABLE pharmacy_preferences ALTER COLUMN address DROP NOT NULL;
ALTER TABLE pharmacy_preferences ALTER COLUMN fax DROP NOT NULL;

-- Column only this phase — see schema.ts's doc comment on prescriptions.pharmacyId.
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS pharmacy_id uuid REFERENCES pharmacies(id);
