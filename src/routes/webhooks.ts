import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { configured, env } from '../config/env';
import { getDb } from '../db/client';
import { appointments, conversations, doctors, earningsLedger, messages, payments, users, type AppointmentRow, type PaymentRow } from '../db/schema';
import { asyncHandler } from '../lib/http';
import { parseAmount } from '../lib/format';
import { computeFeeBreakdown } from '../lib/pricing';
import { getPlatformSettings } from '../services/platformSettings';
import { notify } from '../services/notify';
import { capturePaypalOrder, verifyPaypalWebhook } from '../services/payments/paypal';
import { recordPromoRedemption } from '../services/promos';
import { verifyStreamWebhook } from '../services/stream';

/**
 * Credit the provider's wallet for a just-confirmed visit.
 *
 * Checkout (routes/payments.ts, task 0.1.d) is meant to compute and persist
 * the fee breakdown on the payment row up front; this only recomputes it as
 * a fallback for a payment that predates that wiring (providerPayout still
 * null), so the split is guaranteed to exist by the time earnings are
 * credited either way — and, once computed, is persisted back onto the
 * payment row so it isn't recomputed on a future retry.
 *
 * Idempotent: skips if this appointment already has an 'earning' row (belt
 * and suspenders — confirmPaidAppointment's own status guard already stops a
 * duplicate webhook from reaching here a second time).
 */
async function creditDoctorEarning(appt: AppointmentRow, payment: PaymentRow): Promise<void> {
  if (!appt.doctorId) return; // no linked doctor profile — nothing to credit

  const db = getDb();
  let providerPayout = payment.providerPayout;
  if (providerPayout == null) {
    const rates = await getPlatformSettings();
    const breakdown = computeFeeBreakdown(payment.consultationFee ?? parseAmount(appt.fee), appt.type, rates);
    await db
      .update(payments)
      .set({
        consultationFee: breakdown.consultationFee,
        serviceCharge: breakdown.serviceCharge,
        vat: breakdown.vat,
        providerCommission: breakdown.providerCommission,
        providerPayout: breakdown.providerPayout,
      })
      .where(eq(payments.id, payment.id));
    providerPayout = breakdown.providerPayout;
  }

  const [already] = await db
    .select()
    .from(earningsLedger)
    .where(and(eq(earningsLedger.appointmentId, appt.id), eq(earningsLedger.kind, 'earning')));
  if (already) return;

  const [patient] = await db.select().from(users).where(eq(users.id, appt.patientId));
  await db.insert(earningsLedger).values({
    doctorId: appt.doctorId,
    kind: 'earning',
    title: patient ? `${patient.firstName} ${patient.lastName}` : 'Patient',
    date: appt.date,
    time: appt.time,
    amount: providerPayout,
    status: 'settled',
    appointmentId: appt.id,
  });
}

/**
 * A verified payment succeeded — confirm the visit, tell the patient, credit
 * the provider's wallet, and count the promo redemption (if any).
 *
 * This is the ONLY place an appointment becomes 'upcoming'. Guarded on
 * 'pending_payment' so a late or duplicate webhook can't resurrect a visit the
 * patient cancelled (or re-confirm one already confirmed) after the fact —
 * that same guard is what keeps creditDoctorEarning and the redemption below
 * from double-firing on a webhook retry, since a retry finds the appointment
 * already 'upcoming' and returns before reaching them.
 */
async function confirmPaidAppointment(appointmentId: string): Promise<void> {
  const db = getDb();
  const [appt] = await db
    .update(appointments)
    .set({ status: 'upcoming' })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, 'pending_payment')))
    .returning();

  if (!appt) {
    console.warn(`[webhook] payment settled for appointment ${appointmentId}, but it was not awaiting payment — not confirming.`);
    return;
  }
  await notify(
    appt.patientId,
    'Appointment Confirmed',
    `Your payment of ${appt.fee} was received. Your visit with ${appt.doctorName} on ${appt.date} at ${appt.time} is confirmed.`,
  );
  if (appt.doctorId) {
    const [doc] = await db.select().from(doctors).where(eq(doctors.id, appt.doctorId));
    if (doc?.userId) {
      await notify(doc.userId, 'Visit Confirmed', `The ${appt.date} ${appt.time} visit is paid and confirmed.`);
    }
  }

  // Fetched once and shared: crediting the provider and counting a promo
  // redemption both key off this same settled payment row.
  const [payment] = await db
    .select()
    .from(payments)
    .where(eq(payments.appointmentId, appt.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  if (!payment) return; // shouldn't happen — a webhook just confirmed a payment that must exist

  await creditDoctorEarning(appt, payment);
  // Only counted here, on a settled payment — never at checkout/preview time
  // — so an abandoned checkout can never burn a limited code's supply.
  if (payment.promoCode && payment.discount > 0) {
    await recordPromoRedemption(payment.id, payment.promoCode, appt.patientId, payment.discount);
  }
}

const router = Router();

/** The subset of Stream's webhook payload we act on. */
interface StreamWebhookEvent {
  type: string;
  cid?: string;
  channel_id?: string;
  message?: {
    id: string;
    text?: string;
    user?: { id?: string };
    created_at?: string;
  };
}

/**
 * POST /webhooks/flutterwave — confirm payments server-side only.
 * Flutterwave signs webhooks with a static secret hash in the `verif-hash`
 * header; we compare it before trusting the event. On success we mark the
 * payment succeeded and the appointment confirmed — the client is never trusted.
 */
router.post(
  '/flutterwave',
  asyncHandler(async (req, res) => {
    const signature = req.headers['verif-hash'];
    if (!env.flutterwave.webhookHash || signature !== env.flutterwave.webhookHash) {
      res.status(401).json({ message: 'Invalid webhook signature' });
      return;
    }

    const event = req.body as { data?: { tx_ref?: string; status?: string } };
    const txRef = event.data?.tx_ref; // we set tx_ref = our payment id
    const paid = event.data?.status === 'successful';

    if (txRef) {
      const db = getDb();
      const [payment] = await db
        .update(payments)
        .set({ status: paid ? 'succeeded' : 'failed' })
        .where(eq(payments.id, txRef))
        .returning();
      if (paid && payment?.appointmentId) {
        await confirmPaidAppointment(payment.appointmentId);
      }
    }
    res.json({ received: true });
  }),
);

/** The subset of PayPal's webhook payload we act on. */
interface PaypalWebhookEvent {
  event_type?: string;
  resource?: {
    /** Order id on CHECKOUT.* events; capture id on PAYMENT.CAPTURE.* events. */
    id?: string;
    /** Round-tripped from order creation — this is our payment id. */
    custom_id?: string;
  };
}

/**
 * POST /webhooks/paypal — verified payment lifecycle:
 *   CHECKOUT.ORDER.APPROVED    → capture the order server-side
 *   PAYMENT.CAPTURE.COMPLETED  → mark the payment succeeded (via custom_id)
 *   PAYMENT.CAPTURE.DENIED     → mark it failed
 * Every event is first verified through PayPal's verify-webhook-signature API
 * (requires PAYPAL_WEBHOOK_ID) — the client is never trusted.
 */
router.post(
  '/paypal',
  asyncHandler(async (req, res) => {
    if (!configured.paypal() || !env.paypal.webhookId) {
      res.status(503).json({ message: 'PayPal webhook not configured (set PAYPAL_WEBHOOK_ID)' });
      return;
    }

    const verified = await verifyPaypalWebhook(
      {
        transmissionId: req.header('paypal-transmission-id') ?? '',
        transmissionTime: req.header('paypal-transmission-time') ?? '',
        transmissionSig: req.header('paypal-transmission-sig') ?? '',
        certUrl: req.header('paypal-cert-url') ?? '',
        authAlgo: req.header('paypal-auth-algo') ?? '',
      },
      req.body,
    );
    if (!verified) {
      res.status(401).json({ message: 'Invalid webhook signature' });
      return;
    }

    const event = req.body as PaypalWebhookEvent;

    // Buyer approved in the PayPal UI — capture so the money actually moves.
    // PayPal then emits PAYMENT.CAPTURE.COMPLETED, which marks us paid below.
    if (event.event_type === 'CHECKOUT.ORDER.APPROVED' && event.resource?.id) {
      try {
        await capturePaypalOrder(event.resource.id);
      } catch (err) {
        // Ack anyway; PayPal retries approval events and capture is idempotent.
        console.error('[paypal webhook] capture failed:', err instanceof Error ? err.message : err);
      }
    }

    const captureOutcome =
      event.event_type === 'PAYMENT.CAPTURE.COMPLETED'
        ? 'succeeded'
        : event.event_type === 'PAYMENT.CAPTURE.DENIED'
          ? 'failed'
          : null;
    const paymentId = event.resource?.custom_id; // set at order creation = our payment id

    if (captureOutcome && paymentId) {
      const db = getDb();
      const [payment] = await db
        .update(payments)
        .set({ status: captureOutcome })
        .where(eq(payments.id, paymentId))
        .returning();
      if (captureOutcome === 'succeeded' && payment?.appointmentId) {
        await confirmPaidAppointment(payment.appointmentId);
      }
    }

    res.json({ received: true });
  }),
);

/**
 * POST /webhooks/stream — persist Stream Chat messages to our DB (the pitch's
 * universal EMR + moderation both need server-owned transcripts). Point your
 * Stream app's webhook URL here; Stream signs each call with an `X-Signature`
 * header (HMAC of the raw body using the API secret).
 */
router.post(
  '/stream',
  asyncHandler(async (req, res) => {
    if (!configured.stream()) {
      res.status(503).json({ message: 'Stream not configured' });
      return;
    }
    const signature = req.header('X-Signature') ?? '';
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
    if (!signature || !verifyStreamWebhook(raw, signature)) {
      res.status(401).json({ message: 'Invalid webhook signature' });
      return;
    }

    const event = req.body as StreamWebhookEvent;
    const message = event.message;
    const senderId = message?.user?.id;
    // Our channel id === the conversation id (we create channels that way).
    const channelId = event.channel_id ?? event.cid?.split(':')[1];

    if (event.type === 'message.new' && message && senderId && channelId) {
      try {
        const db = getDb();
        const [conversation] = await db.select().from(conversations).where(eq(conversations.id, channelId));
        if (conversation) {
          await db
            .insert(messages)
            .values({
              // Stream's id is an arbitrary string, so it goes in streamId (a
              // unique text column) — not the uuid PK, which previously made
              // every one of these inserts throw.
              streamId: message.id,
              conversationId: channelId,
              senderId,
              text: message.text ?? '',
              createdAt: message.created_at ? new Date(message.created_at) : new Date(),
            })
            .onConflictDoNothing({ target: messages.streamId }); // dedupe retries
          await db
            .update(conversations)
            .set({
              lastMessage: message.text ?? '',
              updatedAt: new Date(),
              unread: senderId === conversation.patientId ? conversation.unread : conversation.unread + 1,
            })
            .where(eq(conversations.id, channelId));

          // Tell the other party. The doctor side only has a user to notify
          // when the doctor profile is linked to an account.
          if (senderId === conversation.patientId) {
            const [doc] = await db.select().from(doctors).where(eq(doctors.id, conversation.doctorId));
            if (doc?.userId) await notify(doc.userId, 'New Message', message.text ?? 'You have a new message.');
          } else {
            await notify(conversation.patientId, 'New Message', message.text ?? 'You have a new message.');
          }
        }
      } catch (err) {
        // Log but still ack, so Stream doesn't retry a poison message forever.
        console.error('[stream webhook] persist failed:', err instanceof Error ? err.message : err);
      }
    }

    res.json({ received: true });
  }),
);

export default router;
