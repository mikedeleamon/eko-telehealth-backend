-- Promo / discount codes (task 0.2): admin-managed codes patients can apply
-- at checkout.
--
-- Adds:
--   payments.promo_code — the code applied at checkout (uppercased), when
--     discount > 0. payments.discount itself already exists (migration
--     0003) — this only adds the traceability of WHICH code produced it, so
--     webhooks.ts knows what to redeem-count once the payment settles.
--   promo_codes — the admin-managed code definitions (GET/POST/PATCH
--     /admin/promos).
--   promo_redemptions — one row per SETTLED redemption (never for an
--     abandoned checkout — see services/promos.ts). maxRedemptions/
--     perUserLimit are enforced by counting these rows, not a stored
--     counter, so a count can never drift from reality.
--
-- Fully idempotent — safe to run repeatedly and safe on a database freshly
-- created from the current schema.ts.
--
--   psql "$DATABASE_URL" -f migrations/0004_promo_codes.sql
-- or paste into the Supabase SQL editor, or:
--   railway run psql "$DATABASE_URL" -f migrations/0004_promo_codes.sql

ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_code text;

CREATE TABLE IF NOT EXISTS promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('percent', 'flat')),
  value double precision NOT NULL,
  min_spend double precision NOT NULL DEFAULT 0,
  max_redemptions integer,
  per_user_limit integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id uuid NOT NULL REFERENCES promo_codes(id),
  user_id uuid NOT NULL REFERENCES users(id),
  payment_id uuid NOT NULL REFERENCES payments(id),
  discount double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One-time demo code so the feature is testable immediately after migrating,
-- matching the seed script's SAVE20 (see db/seed.ts). Idempotent — only
-- inserted if a code with this name doesn't already exist.
INSERT INTO promo_codes (code, kind, value, min_spend, max_redemptions, per_user_limit, active)
SELECT 'SAVE20', 'percent', 0.20, 0, NULL, 1, true
WHERE NOT EXISTS (SELECT 1 FROM promo_codes WHERE code = 'SAVE20');
