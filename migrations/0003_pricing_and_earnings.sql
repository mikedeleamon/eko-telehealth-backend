-- Pricing engine + doctor earnings ledger (P0.1): schema for a server-side,
-- admin-managed fee split, and the wallet the client's earnings screen has
-- been calling into that never existed on the backend.
--
-- Adds:
--   platform_settings — single-row table of admin-managed rates (service
--     charge %, provider commission %, VAT %). Read by
--     services/platformSettings.ts, which also seeds a default row on first
--     read if this migration hasn't run yet — but running this migration
--     seeds it explicitly so the row exists from the start.
--   payments.{consultation_fee,service_charge,vat,discount,
--     provider_commission,provider_payout} — the fee split, in canonical
--     NGN, independent of amount/currency (what was actually charged at the
--     gateway — e.g. USD for PayPal). VAT is patient-borne (added to the
--     total on top, never withheld from the provider) and only applies to
--     Video Visit — Clinic Visit / Home Visit (in-person) are VAT-exempt.
--   earnings_ledger — the doctor wallet: one row per earning (a visit's
--     payout) or withdrawal. GET /practice/earnings derives
--     balance/pending/thisMonth from this table.
--
-- Fully idempotent: every statement uses IF NOT EXISTS / IF EXISTS guards or
-- a WHERE NOT EXISTS, so it is safe to run repeatedly and safe on a database
-- freshly created from the current schema.ts. `npm run db:push` HANGS on
-- interactive prompts in this project (no TTY under `railway run`), so apply
-- this SQL directly instead:
--
--   psql "$DATABASE_URL" -f migrations/0003_pricing_and_earnings.sql
-- or paste into the Supabase SQL editor, or:
--   railway run psql "$DATABASE_URL" -f migrations/0003_pricing_and_earnings.sql
--
-- After applying, re-run the seed if you want the new demo earnings rows:
--   railway run npm run db:seed

-- ── Platform settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_charge_pct double precision NOT NULL DEFAULT 0,
  commission_pct double precision NOT NULL DEFAULT 0.175,
  vat_pct double precision NOT NULL DEFAULT 0.075,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed exactly one row if the table is empty. Every reader takes "the first
-- row"; without this, a fresh table has no rates until an admin saves once
-- (services/platformSettings.ts also seeds on first read as a fallback, but
-- doing it here means the row exists immediately after migrating).
INSERT INTO platform_settings (service_charge_pct, commission_pct, vat_pct)
SELECT 0, 0.175, 0.075
WHERE NOT EXISTS (SELECT 1 FROM platform_settings);

-- ── Payment fee breakdown ───────────────────────────────────────────────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS consultation_fee double precision;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_charge double precision;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS vat double precision;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount double precision NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_commission double precision;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_payout double precision;

-- Backfill rows that predate the split: treat the full charged amount as the
-- consultation fee with nothing withheld and no VAT collected, so historical
-- data stays consistent (patientTotal − providerPayout − platformNet − vat
-- still reconciles to 0) rather than showing nulls.
UPDATE payments
SET consultation_fee = amount,
    service_charge = 0,
    vat = 0,
    provider_commission = 0,
    provider_payout = amount
WHERE consultation_fee IS NULL;

-- ── Doctor earnings ledger ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earnings_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  kind text NOT NULL CHECK (kind IN ('earning', 'withdrawal')),
  title text NOT NULL,
  date text NOT NULL,
  time text NOT NULL,
  amount double precision NOT NULL,
  status text NOT NULL DEFAULT 'settled' CHECK (status IN ('settled', 'pending')),
  appointment_id uuid REFERENCES appointments(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One-time backfill: every already-succeeded payment implies an earning that
-- had no ledger to land in before this table existed. Insert one 'earning'
-- row per such payment (skipping any appointment that already has one), so
-- doctors don't lose historical balance when this ships.
INSERT INTO earnings_ledger (doctor_id, kind, title, date, time, amount, status, appointment_id, created_at)
SELECT
  a.doctor_id,
  'earning',
  COALESCE(NULLIF(trim(u.first_name || ' ' || u.last_name), ''), 'Patient'),
  a.date,
  a.time,
  p.provider_payout,
  'settled',
  a.id,
  p.created_at
FROM payments p
JOIN appointments a ON a.id = p.appointment_id
LEFT JOIN users u ON u.id = a.patient_id
WHERE p.status = 'succeeded'
  AND a.doctor_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM earnings_ledger el WHERE el.appointment_id = a.id AND el.kind = 'earning'
  );
