/**
 * Promo / discount codes (task 0.2). Two entry points:
 *   - applyPromo    checkout & preview call this to fold a code into a fee
 *                    breakdown, without writing anything.
 *   - recordPromoRedemption   webhooks.ts calls this ONLY once a payment has
 *                    actually settled, so an abandoned checkout never burns
 *                    down a limited code's supply.
 */
import { and, count, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { promoCodes, promoRedemptions } from '../db/schema';
import { computeFeeBreakdown, type FeeBreakdown, type PricingRates, type VisitType } from '../lib/pricing';

export type PromoStatus = 'applied' | 'not_found' | 'inactive' | 'expired' | 'min_spend' | 'limit_reached' | 'user_limit_reached';

export interface PromoResult {
  code: string;
  /** 0 unless status is 'applied'. */
  discount: number;
  status: PromoStatus;
}

/**
 * Look up a promo code and compute the raw discount it grants against
 * `subtotal` (consultationFee + serviceCharge — VAT is a tax, not "spend").
 * Redemption caps are checked against promo_redemptions rows — real,
 * confirmed redemptions only — so previewing a code repeatedly can never
 * exhaust it.
 */
export async function resolvePromo(rawCode: string, userId: string, subtotal: number): Promise<PromoResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code) return { code, discount: 0, status: 'not_found' };

  const db = getDb();
  const [promo] = await db.select().from(promoCodes).where(eq(promoCodes.code, code));
  if (!promo) return { code, discount: 0, status: 'not_found' };
  if (!promo.active) return { code, discount: 0, status: 'inactive' };
  if (promo.expiresAt && promo.expiresAt.getTime() < Date.now()) return { code, discount: 0, status: 'expired' };
  if (subtotal < promo.minSpend) return { code, discount: 0, status: 'min_spend' };

  const [[totalUses], [userUses]] = await Promise.all([
    db.select({ value: count() }).from(promoRedemptions).where(eq(promoRedemptions.promoId, promo.id)),
    db
      .select({ value: count() })
      .from(promoRedemptions)
      .where(and(eq(promoRedemptions.promoId, promo.id), eq(promoRedemptions.userId, userId))),
  ]);
  if (promo.maxRedemptions != null && Number(totalUses?.value ?? 0) >= promo.maxRedemptions) {
    return { code, discount: 0, status: 'limit_reached' };
  }
  if (Number(userUses?.value ?? 0) >= promo.perUserLimit) {
    return { code, discount: 0, status: 'user_limit_reached' };
  }

  const discount = promo.kind === 'percent' ? Math.round(subtotal * promo.value) : Math.round(promo.value);
  return { code, discount, status: 'applied' };
}

/**
 * Fold a (possibly absent, possibly invalid) code into a fee breakdown.
 * Always returns a usable breakdown — discount is simply 0 when there's no
 * valid code, so callers never need a separate "no code" branch.
 */
export async function applyPromo(
  consultationFee: number,
  visitType: VisitType,
  rates: PricingRates,
  userId: string,
  rawCode: string | undefined,
): Promise<{ breakdown: FeeBreakdown; promoCode: string | null; promoStatus: PromoStatus | null }> {
  if (!rawCode) {
    return { breakdown: computeFeeBreakdown(consultationFee, visitType, rates), promoCode: null, promoStatus: null };
  }
  // A draft with no discount just to learn serviceCharge for the minSpend
  // check — cheap (pure function, no I/O) and keeps resolvePromo decoupled
  // from pricing internals.
  const draft = computeFeeBreakdown(consultationFee, visitType, rates);
  const result = await resolvePromo(rawCode, userId, consultationFee + draft.serviceCharge);
  const breakdown = computeFeeBreakdown(consultationFee, visitType, rates, result.discount);
  return {
    breakdown,
    promoCode: result.status === 'applied' ? result.code : null,
    promoStatus: result.status,
  };
}

/**
 * Record a redemption for a settled payment. Idempotent per payment — a
 * webhook retry won't double-count (checked by paymentId, not promoId+user,
 * since a user could legitimately redeem the same code again on a future
 * visit once perUserLimit allows it).
 */
export async function recordPromoRedemption(paymentId: string, code: string, userId: string, discount: number): Promise<void> {
  const db = getDb();
  const [promo] = await db.select().from(promoCodes).where(eq(promoCodes.code, code));
  if (!promo) return; // code was deleted/renamed between checkout and settlement — nothing to count

  const [already] = await db.select().from(promoRedemptions).where(eq(promoRedemptions.paymentId, paymentId));
  if (already) return;

  await db.insert(promoRedemptions).values({ promoId: promo.id, userId, paymentId, discount });
}
