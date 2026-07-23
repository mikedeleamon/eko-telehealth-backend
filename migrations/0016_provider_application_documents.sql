-- Verification documents for provider applications (Batch 3 Phase 1 —
-- vetting). Applicants upload to R2 (POST /uploads/presign kind:'provider-doc')
-- and the resulting keys land here at submit time; not required to submit —
-- the admin still makes the approve/reject call either way, same as the
-- pre-existing check booleans.
--
--   psql "$DATABASE_URL" -f migrations/0016_provider_application_documents.sql

ALTER TABLE provider_applications ADD COLUMN IF NOT EXISTS documents jsonb NOT NULL DEFAULT '[]'::jsonb;
