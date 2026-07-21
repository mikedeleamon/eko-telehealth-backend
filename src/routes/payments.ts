import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env';
import { getDb } from '../db/client';
import { appointments, payments, type PaymentRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { parseAmount } from '../lib/format';
import { requireAuth } from '../middleware/auth';
import { createCheckout } from '../services/payments';
import { getPlatformSettings } from '../services/platformSettings';
import { applyPromo } from '../services/promos';

const router = Router();
router.use(requireAuth);

/** Shape returned by both POST /intent and GET /:id — the charge plus its NGN breakdown. */
function toPaymentPayload(p: PaymentRow) {
  return {
    id: p.id,
    provider: p.provider,
    amount: p.amount,
    currency: p.currency,
    checkoutRef: p.checkoutRef,
    status: p.status,
    // NGN breakdown (see lib/pricing.ts) — independent of amount/currency
    // above, which is what was actually charged at the gateway. Undefined
    // only for payments that predate the pricing engine and haven't been
    // touched by webhooks.ts's fallback computation yet.
    consultationFee: p.consultationFee ?? undefined,
    serviceCharge: p.serviceCharge ?? undefined,
    vat: p.vat ?? undefined,
    discount: p.discount,
    promoCode: p.promoCode ?? undefined,
    providerCommission: p.providerCommission ?? undefined,
    providerPayout: p.providerPayout ?? undefined,
  };
}

/**
 * POST /payments/intent — create a Flutterwave / PayPal checkout for a visit.
 *
 * Only for an appointment the doctor has already accepted. Paying for an
 * unapproved request would take money for a visit that may never happen;
 * paying for a confirmed one would double-charge.
 */
router.post(
  '/intent',
  asyncHandler(async (req, res) => {
    const { appointmentId, provider, code } = z
      .object({
        appointmentId: z.string().uuid(),
        provider: z.enum(['flutterwave', 'paypal']),
        code: z.string().trim().max(32).optional(),
      })
      .parse(req.body);

    const db = getDb();
    const [appt] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, appointmentId), eq(appointments.patientId, req.user!.id)));
    if (!appt) throw new HttpError(404, 'Appointment not found');
    if (appt.status !== 'pending_payment') {
      throw new HttpError(
        409,
        appt.status === 'pending_approval'
          ? 'The doctor has not accepted this request yet.'
          : `This appointment is not awaiting payment (it is ${appt.status}).`,
      );
    }

    const consultationFee = parseAmount(appt.fee) || 15000;
    const rates = await getPlatformSettings();
    // Service charge + VAT (Video Visit only, patient-borne) are added on top
    // of the doctor's fee here — this is the actual charge, not just the fee.
    // The code is re-validated here (never trust the client's discount
    // number) — GET /preview is where the patient gets live feedback; if a
    // code stopped being valid between preview and tapping Pay, this just
    // silently proceeds at discount 0 rather than blocking the purchase.
    const { breakdown, promoCode } = await applyPromo(consultationFee, appt.type, rates, req.user!.id, code);

    // Flutterwave settles NGN. PayPal can't, so charge the configured currency
    // (USD by default), converting the NGN patient total at the configured
    // rate (2 dp). Either way, amount is what's charged — patientTotal, not
    // the raw consultation fee.
    const { amount, currency } =
      provider === 'paypal'
        ? { amount: Math.round((breakdown.patientTotal / env.paypal.ngnRate) * 100) / 100, currency: env.paypal.currency }
        : { amount: breakdown.patientTotal, currency: 'NGN' };

    // Record the intent first so the webhook has a row to reconcile against.
    // The NGN breakdown is persisted now so webhooks.ts credits the provider
    // from these exact numbers instead of recomputing them at settlement.
    // promoCode is stamped here too, so webhooks.ts knows which code to
    // redeem-count once (and only once) this payment actually settles.
    const [payment] = await db
      .insert(payments)
      .values({
        appointmentId: appt.id,
        provider,
        amount,
        currency,
        checkoutRef: '',
        status: 'pending',
        consultationFee: breakdown.consultationFee,
        serviceCharge: breakdown.serviceCharge,
        vat: breakdown.vat,
        discount: breakdown.discount,
        promoCode,
        providerCommission: breakdown.providerCommission,
        providerPayout: breakdown.providerPayout,
      })
      .returning();

    const { checkoutRef } = await createCheckout(provider, {
      txRef: payment!.id,
      amount,
      currency,
      customerEmail: req.user!.email,
      redirectUrl: env.paymentRedirectUrl,
    });

    const [updated] = await db
      .update(payments)
      .set({ checkoutRef })
      .where(eq(payments.id, payment!.id))
      .returning();

    res.status(201).json(toPaymentPayload(updated!));
  }),
);

/**
 * GET /payments/preview/:appointmentId?code=SAVE20 — the fee breakdown for a
 * visit, without creating a payment row or checkout session. Lets the client
 * show "you'll pay ₦X" (PaymentScreen) before the patient commits to a
 * specific provider — POST /intent is what actually starts a checkout.
 *
 * `code` is optional; when present, promoStatus explains the result
 * ('applied', or why not — 'expired', 'min_spend', etc.) so the UI can show
 * a specific message instead of the discount just silently not appearing.
 */
router.get(
  '/preview/:appointmentId',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [appt] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, param(req, 'appointmentId')), eq(appointments.patientId, req.user!.id)));
    if (!appt) throw new HttpError(404, 'Appointment not found');

    const consultationFee = parseAmount(appt.fee) || 15000;
    const rates = await getPlatformSettings();
    const rawCode = typeof req.query.code === 'string' ? req.query.code : undefined;
    const { breakdown, promoStatus } = await applyPromo(consultationFee, appt.type, rates, req.user!.id, rawCode);
    res.json({ ...breakdown, promoStatus });
  }),
);

/**
 * GET /payments/:id — poll a payment's outcome after the hosted checkout.
 *
 * The provider redirects the app back with no trustworthy result, and the
 * webhook lands out-of-band, so this is how the client learns whether the
 * money actually moved. Scoped to the payer's own appointments.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db
      .select({ payment: payments, appointmentStatus: appointments.status })
      .from(payments)
      .innerJoin(appointments, eq(payments.appointmentId, appointments.id))
      .where(and(eq(payments.id, param(req, 'id')), eq(appointments.patientId, req.user!.id)));
    if (!row) throw new HttpError(404, 'Payment not found');

    res.json({
      ...toPaymentPayload(row.payment),
      /** The visit is only truly booked once this reads 'upcoming'. */
      appointmentStatus: row.appointmentStatus,
    });
  }),
);

export default router;
