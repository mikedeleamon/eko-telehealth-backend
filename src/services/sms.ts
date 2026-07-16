/**
 * SMS via Termii (getstream-of-SMS for Nigeria: naira pricing, OTP-optimized
 * local routes). Plain sender — we generate + verify the code ourselves (same
 * as the Resend email OTP); Termii just delivers the message. When
 * TERMII_API_KEY is absent we log and no-op so flows still succeed in dev.
 */
import { configured, env } from '../config/env';

/** Termii wants MSISDN in international format without '+': e.g. 2348012345678. */
function normalizeMsisdn(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = env.termii.defaultCountryCode + digits.slice(1);
  return digits;
}

export async function sendSms(to: string, message: string): Promise<void> {
  if (!configured.sms()) {
    console.warn(`[sms] Termii not configured — would send to ${to}: "${message}"`);
    return;
  }
  const res = await fetch(`${env.termii.baseUrl}/api/sms/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: normalizeMsisdn(to),
      from: env.termii.senderId,
      sms: message,
      type: 'plain',
      channel: env.termii.channel,
      api_key: env.termii.apiKey,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error('[sms] Termii send failed:', data);
  }
}
