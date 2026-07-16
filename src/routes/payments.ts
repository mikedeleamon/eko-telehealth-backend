import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../config/env';
import { getDb } from '../db/client';
import { appointments, payments } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { parseAmount } from '../lib/format';
import { requireAuth } from '../middleware/auth';
import { createCheckout } from '../services/payments';

const router = Router();
router.use(requireAuth);

/** POST /payments/intent — create a Flutterwave / PayPal checkout for a visit. */
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

export default router;
