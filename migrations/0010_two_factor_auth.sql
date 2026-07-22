-- Login 2FA opt-in flag. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled boolean NOT NULL DEFAULT false;
