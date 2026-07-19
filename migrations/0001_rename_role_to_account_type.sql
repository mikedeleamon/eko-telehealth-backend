-- Rename the account-type attribute from `role` to `account_type`.
--
-- Run this against the Supabase database BEFORE `npm run db:push` on a schema
-- that still has the old column. Renaming preserves the data; letting
-- drizzle-kit push reconcile it instead would be treated as a drop+add and
-- lose every account's type.
--
-- Idempotent: safe to run on a database that has already been renamed (or one
-- freshly created from the new schema, where account_type already exists).
--
-- Apply with either:
--   psql "$DATABASE_URL" -f migrations/0001_rename_role_to_account_type.sql
-- or by pasting into the Supabase SQL editor.
--
-- Note: access tokens minted before this change carry the old `role` JWT
-- claim, which the backend no longer reads — existing sessions will 401 and
-- users must sign in again.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'account_type'
  ) THEN
    ALTER TABLE users RENAME COLUMN role TO account_type;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_signups' AND column_name = 'role'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_signups' AND column_name = 'account_type'
  ) THEN
    ALTER TABLE pending_signups RENAME COLUMN role TO account_type;
  END IF;
END $$;
