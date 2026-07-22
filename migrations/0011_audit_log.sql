-- EMR audit log: who touched a clinical record (documents/prescriptions/labs/
-- medical_notes) and when, written by the auditAccess middleware
-- (src/middleware/audit.ts) on every read and write of those routes.
-- Write-only for v1 — no admin viewer, queried directly for a compliance
-- audit. Idempotent.
--
--   psql "$DATABASE_URL" -f migrations/0011_audit_log.sql

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  actor_account_type text NOT NULL CHECK (actor_account_type IN ('Patient', 'Doctor', 'Admin')),
  action text NOT NULL CHECK (action IN ('read', 'create', 'update', 'delete')),
  resource_type text NOT NULL CHECK (resource_type IN ('document', 'prescription', 'lab', 'medical_note')),
  resource_id text,
  subject_id text,
  status_code integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_subject_id_idx ON audit_log (subject_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_id_idx ON audit_log (actor_id);
