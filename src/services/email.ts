/**
 * Transactional email via Resend. When RESEND_API_KEY is absent we log and
 * no-op so flows like /auth/forgot-password still succeed in development.
 */
import { Resend } from 'resend';
import { configured, env } from '../config/env';

let resend: Resend | null = null;

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!configured.resend()) {
    console.warn(`[email] Resend not configured — would send "${subject}" to ${to}`);
    return;
  }
  if (!resend) resend = new Resend(env.resend.apiKey);
  const { error } = await resend.emails.send({ from: env.resend.from, to, subject, html });
  if (error) console.error('[email] Resend error:', error);
}
