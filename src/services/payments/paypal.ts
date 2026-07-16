/**
 * PayPal Orders v2 (diaspora payments). Creates an order server-side and
 * returns its id as PaymentIntent.checkoutRef; the app approves + captures via
 * the PayPal SDK. Note: PayPal does not settle NGN — use USD (or another
 * supported currency) for PayPal and reserve Flutterwave for NGN cards.
 */
import { configured, env } from '../../config/env';
import { HttpError, ServiceNotConfiguredError } from '../../lib/errors';

const baseUrl = () => (env.paypal.environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

async function getAccessToken(): Promise<string> {
  const creds = Buffer.from(`${env.paypal.clientId}:${env.paypal.secret}`).toString('base64');
  const res = await fetch(`${baseUrl()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = (await res.json()) as { access_token?: string };
  if (!res.ok || !data.access_token) throw new HttpError(502, 'PayPal authentication failed', data);
  return data.access_token;
}

export async function createPaypalOrder(args: {
  txRef: string;
  amount: number;
  currency: string;
}): Promise<{ checkoutRef: string }> {
  if (!configured.paypal()) {
    throw new ServiceNotConfiguredError('PayPal (set PAYPAL_CLIENT_ID and PAYPAL_SECRET)');
  }
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          // custom_id round-trips through capture webhooks, so events map back
          // to our payment row (PayPal's equivalent of Flutterwave's tx_ref).
          custom_id: args.txRef,
          amount: { currency_code: args.currency, value: args.amount.toFixed(2) },
        },
      ],
    }),
  });
  const data = (await res.json()) as { id?: string };
  if (!res.ok || !data.id) throw new HttpError(502, 'PayPal order creation failed', data);
  return { checkoutRef: data.id };
}

/** Capture an approved order (called from the CHECKOUT.ORDER.APPROVED webhook). */
export async function capturePaypalOrder(orderId: string): Promise<void> {
  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new HttpError(502, 'PayPal capture failed', await res.json().catch(() => undefined));
  }
}

export interface PaypalWebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

/**
 * Verify a webhook came from PayPal, using their verification API (the
 * documented approach: POST the transmission headers + event and check for
 * verification_status SUCCESS). Requires PAYPAL_WEBHOOK_ID.
 */
export async function verifyPaypalWebhook(headers: PaypalWebhookHeaders, event: unknown): Promise<boolean> {
  if (!configured.paypal() || !env.paypal.webhookId) return false;
  if (!headers.transmissionId || !headers.transmissionSig) return false;

  const token = await getAccessToken();
  const res = await fetch(`${baseUrl()}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transmission_id: headers.transmissionId,
      transmission_time: headers.transmissionTime,
      transmission_sig: headers.transmissionSig,
      cert_url: headers.certUrl,
      auth_algo: headers.authAlgo,
      webhook_id: env.paypal.webhookId,
      webhook_event: event,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { verification_status?: string };
  return res.ok && data.verification_status === 'SUCCESS';
}
