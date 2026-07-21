-- Language capture + matching (task 2.5).
--
-- Adds:
--   users.spokenLanguages              — personal, editable anytime via
--                                         PATCH /auth/me (EditProfileScreen).
--                                         Distinct from the app's own display
--                                         language (i18n) — this is who the
--                                         account holder can communicate with.
--   provider_applications.spokenLanguages — captured once at self-service
--                                         application (POST /providers/apply).
--   doctors.spokenLanguages            — carried onto the doctors row on
--                                         approval, same as specialty/fee/
--                                         location. What FilterScreen's
--                                         language chips actually search.
--
-- Idempotent — safe to run repeatedly and safe on a database freshly created
-- from the current schema.ts.
--
--   psql "$DATABASE_URL" -f migrations/0006_spoken_languages.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS spoken_languages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS spoken_languages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE provider_applications ADD COLUMN IF NOT EXISTS spoken_languages jsonb NOT NULL DEFAULT '[]';
