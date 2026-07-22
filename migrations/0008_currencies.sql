-- Display multi-currency (task 2.4). NGN stays the platform's canonical
-- pricing/settlement currency everywhere (lib/pricing.ts is unchanged) — this
-- only lets a patient browse/preview fees converted into a currency of their
-- choosing.
--
-- Adds:
--   users.preferred_currency  — personal display preference, editable via
--                                PATCH /auth/me, defaults 'NGN' (no-op).
--   currencies                — admin-managed display rates (GET/POST/PATCH
--                                /admin/currencies), seeded with NGN (base,
--                                rate 1) plus a few common ones.
--
-- Idempotent — safe to run repeatedly and safe on a database freshly created
-- from the current schema.ts.
--
--   psql "$DATABASE_URL" -f migrations/0008_currencies.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_currency text NOT NULL DEFAULT 'NGN';

CREATE TABLE IF NOT EXISTS currencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  symbol text NOT NULL,
  ngn_rate double precision NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO currencies (code, symbol, ngn_rate, active)
SELECT 'NGN', '₦', 1, true
WHERE NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'NGN');

INSERT INTO currencies (code, symbol, ngn_rate, active)
SELECT 'USD', '$', 1600, true
WHERE NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'USD');

INSERT INTO currencies (code, symbol, ngn_rate, active)
SELECT 'GBP', '£', 2000, true
WHERE NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'GBP');

INSERT INTO currencies (code, symbol, ngn_rate, active)
SELECT 'EUR', '€', 1750, true
WHERE NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'EUR');
