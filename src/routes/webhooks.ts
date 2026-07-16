import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { configured, env } from '../config/env';
import { getDb } from '../db/client';
import { appointments, conversations, messages, payments } from '../db/schema';
import { asyncHandler } from '../lib/http';
import { capturePaypalOrder, verifyPaypalWebhook } from '../services/payments/paypal';
import { verifyStreamWebhook } from '../services/stream';

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
        await db.update(appointments).set({ status: 'upcoming' }).where(eq(appointments.id, payment.appointmentId));
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
        await db.update(appointments).set({ status: 'upcoming' }).where(eq(appointments.id, payment.appointmentId));
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
              id: message.id, // dedupe webhook retries on Stream's message id
              conversationId: channelId,
              senderId,
              text: message.text ?? '',
              createdAt: message.created_at ? new Date(message.created_at) : new Date(),
            })
            .onConflictDoNothing();
          await db
            .update(conversations)
            .set({
              lastMessage: message.text ?? '',
              updatedAt: new Date(),
              unread: senderId === conversation.patientId ? conversation.unread : conversation.unread + 1,
            })
            .where(eq(conversations.id, channelId));
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
