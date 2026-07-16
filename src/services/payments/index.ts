import { HttpError } from '../../lib/errors';
import { createFlutterwaveCheckout } from './flutterwave';
import { createPaypalOrder } from './paypal';

export type PaymentProvider = 'flutterwave' | 'paypal';

interface CheckoutArgs {
  txRef: string;
  amount: number;
  currency: string;
  customerEmail: string;
  redirectUrl: string;
}

/** Route a checkout request to the chosen provider. */
export async function createCheckout(
  provider: PaymentProvider,
  args: CheckoutArgs,
): Promise<{ checkoutRef: string }> {
  if (provider === 'flutterwave') return createFlutterwaveCheckout(args);
  if (provider === 'paypal') {
    return createPaypalOrder({ txRef: args.txRef, amount: args.amount, currency: args.currency });
  }
  throw new HttpError(400, `Unknown payment provider: ${provider}`);
}
