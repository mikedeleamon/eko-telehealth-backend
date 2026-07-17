import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env';
import { getDb } from '../db/client';
import { appointments, payments } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { parseAmount } from '../lib/format';
import { requireAuth } from '../middleware/auth';
import { createCheckout } from '../services/payments';

const router = Router();
router.use(requireAuth);

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
    const { appointmentId, provider } = z
      .object({ appointmentId: z.string().uuid(), provider: z.enum(['flutterwave', 'paypal']) })
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

    const ngnAmount = parseAmount(appt.fee) || 15000;
    // Flutterwave settles NGN. PayPal can't, so charge the configured currency
    // (USD by default), converting the NGN fee at the configured rate (2 dp).
    const { amount, currency } =
      provider === 'paypal'
        ? { amount: Math.round((ngnAmount / env.paypal.ngnRate) * 100) / 100, currency: env.paypal.currency }
        : { amount: ngnAmount, currency: 'NGN' };

    // Record the intent first so the webhook has a row to reconcile against.
    const [payment] = await db
      .insert(payments)
      .values({ appointmentId: appt.id, provider, amount, currency, checkoutRef: '', status: 'pending' })
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

    res.status(201).json({
      id: updated!.id,
      provider: updated!.provider,
      amount: updated!.amount,
      currency: updated!.currency,
      checkoutRef: updated!.checkoutRef,
      status: updated!.status,
    });
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
      id: row.payment.id,
      provider: row.payment.provider,
      amount: row.payment.amount,
      currency: row.payment.currency,
      checkoutRef: row.payment.checkoutRef,
      status: row.payment.status,
      /** The visit is only truly booked once this reads 'upcoming'. */
      appointmentStatus: row.appointmentStatus,
    });
  }),
);

export default router;
