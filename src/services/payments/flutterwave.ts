/**
 * Flutterwave Standard checkout (NGN). The backend creates the checkout and
 * returns the hosted payment link as PaymentIntent.checkoutRef; the appointment
 * is only confirmed later, from the webhook (never trust the client).
 */
import { configured, env } from '../../config/env';
import { HttpError, ServiceNotConfiguredError } from '../../lib/errors';

interface CheckoutArgs {
  txRef: string;
  amount: number;
  currency: string;
  customerEmail: string;
  redirectUrl: string;
}

export async function createFlutterwaveCheckout(args: CheckoutArgs): Promise<{ checkoutRef: string }> {
  if (!configured.flutterwave()) {
    throw new ServiceNotConfiguredError('Flutterwave (set FLUTTERWAVE_SECRET_KEY)');
  }
  const res = await fetch('https://api.flutterwave.com/v3/payments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.flutterwave.secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: args.txRef,
      amount: args.amount,
      currency: args.currency,
      redirect_url: args.redirectUrl,
      customer: { email: args.customerEmail },
      customizations: { title: 'Eko Telehealth' },
    }),
  });
  const data = (await res.json()) as { status?: string; message?: string; data?: { link?: string } };
  if (!res.ok || data.status !== 'success' || !data.data?.link) {
    throw new HttpError(502, data.message ?? 'Flutterwave checkout failed', data);
  }
  return { checkoutRef: data.data.link };
}
