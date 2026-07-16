/**
 * Central runtime configuration for the Eko Telehealth backend.
 *
 * Every external service is optional at boot. `configured.*` reports which
 * ones have credentials; routes whose service is unconfigured answer with a
 * 503 (ServiceNotConfiguredError) instead of crashing — so you can deploy the
 * API first and light up Stream / payments / storage as accounts come online.
 */
import 'dotenv/config';

const num = (v: string | undefined, fallback: number) => (v ? Number(v) : fallback);
const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const stream = {
  apiKey: process.env.STREAM_API_KEY ?? '',
  apiSecret: process.env.STREAM_API_SECRET ?? '',
  tokenTtl: num(process.env.STREAM_TOKEN_TTL, 3600),
  callType: process.env.STREAM_CALL_TYPE ?? 'default',
};

const flutterwave = {
  secretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? '',
  webhookHash: process.env.FLUTTERWAVE_WEBHOOK_HASH ?? '',
};

const paypal = {
  clientId: process.env.PAYPAL_CLIENT_ID ?? '',
  secret: process.env.PAYPAL_SECRET ?? '',
  environment: (process.env.PAYPAL_ENV ?? 'sandbox') as 'sandbox' | 'live',
  // Issued when you register the webhook in the PayPal dashboard; required to
  // verify webhook signatures via /v1/notifications/verify-webhook-signature.
  webhookId: process.env.PAYPAL_WEBHOOK_ID ?? '',
  // PayPal can't settle NGN — charge this currency instead...
  currency: process.env.PAYPAL_CURRENCY ?? 'USD',
  // ...converting the NGN fee at this many NGN per 1 unit of PAYPAL_CURRENCY.
  ngnRate: num(process.env.PAYPAL_NGN_RATE, 1600),
};

const resend = {
  apiKey: process.env.RESEND_API_KEY ?? '',
  from: process.env.EMAIL_FROM ?? 'Eko Telehealth <no-reply@ekotelehealth.com>',
};

const r2 = {
  accountId: process.env.R2_ACCOUNT_ID ?? '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  bucket: process.env.R2_BUCKET ?? '',
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? '',
};

const termii = {
  apiKey: process.env.TERMII_API_KEY ?? '',
  senderId: process.env.TERMII_SENDER_ID ?? 'Eko Health',
  // generic = cheapest SMS route; dnd delivers to Do-Not-Disturb numbers (pricier).
  channel: process.env.TERMII_CHANNEL ?? 'generic',
  baseUrl: process.env.TERMII_BASE_URL ?? 'https://api.ng.termii.com',
  // Local numbers entered as 0803… are prefixed with this (Nigeria = 234).
  defaultCountryCode: process.env.SMS_DEFAULT_COUNTRY_CODE ?? '234',
};

export const env = {
  port: num(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  corsOrigins: list(process.env.CORS_ORIGINS),
  paymentRedirectUrl: process.env.PAYMENT_REDIRECT_URL ?? 'ekotelehealth://payment-complete',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret-change-me',
    accessTtl: num(process.env.JWT_ACCESS_TTL, 3600),
    refreshTtl: num(process.env.JWT_REFRESH_TTL, 2592000),
  },
  databaseUrl: process.env.DATABASE_URL ?? '',
  stream,
  flutterwave,
  paypal,
  resend,
  r2,
  termii,
};

/** Which integrations have enough credentials to run. Surfaced on /health. */
export const configured = {
  db: () => !!env.databaseUrl,
  stream: () => !!(stream.apiKey && stream.apiSecret),
  flutterwave: () => !!flutterwave.secretKey,
  paypal: () => !!(paypal.clientId && paypal.secret),
  resend: () => !!resend.apiKey,
  r2: () => !!(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket),
  sms: () => !!termii.apiKey,
};
