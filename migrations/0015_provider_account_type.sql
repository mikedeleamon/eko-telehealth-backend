-- Widens the account_type vocabulary with 'Provider' — the generic bucket
-- for every non-Doctor provider type (Therapist, Nurse, Pharmacy, ...). The
-- specific domain type lives on provider_applications.type, not here; this
-- enum deliberately does not grow one value per provider type. 'Doctor' is
-- kept as a legacy alias for accounts created before this existed.
--
-- users.account_type and pending_signups.account_type have no DB-level CHECK
-- constraint (confirmed — migrations/0001 only renamed the column), so only
-- complaints.account_type (added with one in migrations/0007) needs updating.
--
--   psql "$DATABASE_URL" -f migrations/0015_provider_account_type.sql

ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_account_type_check;
ALTER TABLE complaints ADD CONSTRAINT complaints_account_type_check
  CHECK (account_type IN ('Patient', 'Doctor', 'Provider'));
