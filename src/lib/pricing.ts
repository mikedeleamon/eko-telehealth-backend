/**
 * The fee-splitting math for a paid visit — the only place it lives. Routes
 * call computeFeeBreakdown() rather than computing shares inline, so the
 * split can't drift between checkout (routes/payments.ts), the earnings
 * credit (routes/webhooks.ts), and admin revenue reporting (routes/admin.ts).
 *
 * Three components, each a percentage of the provider's consultation fee:
 *   - serviceCharge      patient → platform (a new charge on top of the fee)
 *   - providerCommission provider → platform (withheld from their payout)
 *   - vat                patient → platform, on top of the total — NEVER
 *                         withheld from the provider. Waived on in-person
 *                         visits (Clinic Visit / Home Visit); Nigerian VAT
 *                         is only charged on the Video Visit service.
 *
 * Rates are admin-managed (see services/platformSettings.ts) rather than
 * hardcoded here, so this module takes them as a parameter.
 */

export type VisitType = 'Video Visit' | 'Clinic Visit' | 'Home Visit';

export interface PricingRates {
  /** Patient-side platform fee, as a fraction of the consultation fee (e.g. 0.10 = 10%). */
  serviceChargePct: number;
  /** Provider-side commission withheld from payout, as a fraction of the consultation fee. */
  commissionPct: number;
  /** VAT, as a fraction of the consultation fee. Patient-borne; only applied to Video Visits. */
  vatPct: number;
}

export interface FeeBreakdown {
  consultationFee: number;
  serviceCharge: number;
  /** 0 for Clinic Visit / Home Visit — VAT only applies to Video Visit. */
  vat: number;
  /** Amount taken off the platform's share (service charge + commission). Never reduces provider payout or VAT owed. */
  discount: number;
  /** What the patient is charged: consultationFee + serviceCharge + vat − discount. */
  patientTotal: number;
  providerCommission: number;
  /** What the provider is credited: consultationFee − providerCommission. VAT is never withheld from this. */
  providerPayout: number;
  /** What the platform keeps: serviceCharge + providerCommission − discount. Excludes VAT, which is a remitted liability, not revenue. */
  platformNet: number;
}

const round = (n: number) => Math.round(n);

/**
 * Split a consultation fee into what the patient pays, what the provider
 * keeps, and what the platform earns. Pure function — no I/O, no rounding
 * surprises hidden elsewhere. `discount` (from a promo code, task 0.2) is
 * capped so it can only ever eat into the platform's own share
 * (serviceCharge + providerCommission), never into VAT owed or the
 * provider's payout.
 */
export function computeFeeBreakdown(
  consultationFee: number,
  visitType: VisitType,
  rates: PricingRates,
  discount = 0,
): FeeBreakdown {
  if (!Number.isFinite(consultationFee) || consultationFee < 0) {
    throw new Error(`computeFeeBreakdown: consultationFee must be a non-negative number (got ${consultationFee})`);
  }

  const serviceCharge = round(consultationFee * rates.serviceChargePct);
  const providerCommission = round(consultationFee * rates.commissionPct);
  const vat = visitType === 'Video Visit' ? round(consultationFee * rates.vatPct) : 0;

  // Capped at the platform's own share (serviceCharge + providerCommission) —
  // NOT consultationFee + serviceCharge. A discount is a marketing cost the
  // platform absorbs; it must never be able to push platformNet negative.
  const cappedDiscount = Math.max(0, Math.min(discount, serviceCharge + providerCommission));

  const patientTotal = consultationFee + serviceCharge + vat - cappedDiscount;
  const providerPayout = consultationFee - providerCommission;
  const platformNet = serviceCharge + providerCommission - cappedDiscount;

  return {
    consultationFee,
    serviceCharge,
    vat,
    discount: cappedDiscount,
    patientTotal,
    providerCommission,
    providerPayout,
    platformNet,
  };
}
