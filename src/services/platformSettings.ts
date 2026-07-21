/**
 * The platform's fee-schedule rates (service charge / commission / VAT).
 * Admin-managed via GET/PATCH /admin/settings (task 0.1.f, not yet wired) —
 * for now this is the read side, used by checkout (routes/payments.ts, task
 * 0.1.d) and the earnings credit (routes/webhooks.ts).
 *
 * Stored as a single row in `platform_settings`. These defaults mirror the
 * rates migrations/0003_pricing_and_earnings.sql seeds that row with, so a
 * database that predates the migration (or a fresh one that hasn't been
 * migrated yet) still prices correctly instead of throwing.
 */
import { getDb } from '../db/client';
import { platformSettings } from '../db/schema';
import type { PricingRates } from '../lib/pricing';

const DEFAULT_RATES: PricingRates = {
  serviceChargePct: 0,
  commissionPct: 0.175,
  vatPct: 0.075,
};

/**
 * Read the platform's current rates, creating the row with defaults on first
 * read if none exists yet.
 */
export async function getPlatformSettings(): Promise<PricingRates> {
  const db = getDb();
  const [row] = await db.select().from(platformSettings).limit(1);
  if (row) {
    return { serviceChargePct: row.serviceChargePct, commissionPct: row.commissionPct, vatPct: row.vatPct };
  }
  const [created] = await db.insert(platformSettings).values(DEFAULT_RATES).returning();
  return { serviceChargePct: created!.serviceChargePct, commissionPct: created!.commissionPct, vatPct: created!.vatPct };
}
