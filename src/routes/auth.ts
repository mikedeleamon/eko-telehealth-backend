import { Router } from 'express';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { users, verificationCodes, type UserRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { signSession } from '../lib/jwt';
import { hashPassword, verifyPassword } from '../lib/password';
import { sendEmail } from '../services/email';
import { sendSms } from '../services/sms';

const router = Router();
const roleSchema = z.enum(['Patient', 'Doctor']);

/** Shape the { user, accessToken, refreshToken } payload both clients expect. */
function sessionResponse(user: UserRow) {
  const { accessToken, refreshToken } = signSession({ id: user.id, role: user.role, email: user.email });
  return {
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
    },
    accessToken,
    refreshToken,
  };
}

/** POST /auth/login */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password, role } = z
      // role is optional: the mobile app sends it (Patient/Doctor) and we enforce
      // it; the admin console omits it and authenticates on credentials alone.
      .object({ email: z.string().email(), password: z.string().min(1), role: roleSchema.optional() })
      .parse(req.body);

    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, 'Invalid email or password');
    }
    if (user.status === 'suspended') throw new HttpError(403, 'This account has been suspended.');
    // When a role is supplied it must match (Admins may sign in through either client).
    if (role && user.role !== role && user.role !== 'Admin') {
      throw new HttpError(403, `This account is not registered as a ${role}.`);
    }
    res.json(sessionResponse(user));
  }),
);

/** POST /auth/signup */
router.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        email: z.string().email(),
        password: z.string().min(6),
        role: roleSchema,
      })
      .parse(req.body);

    const db = getDb();
    const email = input.email.toLowerCase();
    const [existing] = await db.select().from(users).where(eq(users.email, email));
    if (existing) throw new HttpError(409, 'An account with this email already exists.');

    const [user] = await db
      .insert(users)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      })
      .returning();
    res.status(201).json(sessionResponse(user!));
  }),
);

/** Generate a 6-digit code, store it, and deliver it over the given channel. */
async function issueCode(destination: string, channel: 'email' | 'sms'): Promise<void> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await getDb()
    .insert(verificationCodes)
    .values({
      destination: destination.toLowerCase(),
      channel,
      code,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  const text = `Your Eko Telehealth verification code is ${code}. It expires in 15 minutes.`;
  if (channel === 'sms') {
    await sendSms(destination, text);
  } else {
    await sendEmail(destination, 'Your Eko Telehealth verification code', `<p>${text}</p>`);
  }
}

/** POST /auth/forgot-password — always 200 so we never leak which emails exist. */
router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    await issueCode(email, 'email');
    res.json({ ok: true });
  }),
);

/**
 * POST /auth/send-code — send an email or SMS verification code. Used by the
 * mobile phone-verification / password-reset flows. Always 200 (never reveals
 * whether the destination is registered).
 */
router.post(
  '/send-code',
  asyncHandler(async (req, res) => {
    const { channel, destination } = z
      .object({ channel: z.enum(['email', 'sms']), destination: z.string().min(1) })
      .parse(req.body);
    await issueCode(destination, channel);
    res.json({ ok: true });
  }),
);

/** POST /auth/verify — email / SMS OTP check. */
router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { channel, code } = z
      .object({ channel: z.enum(['email', 'sms']), code: z.string().min(4) })
      .parse(req.body);
    const db = getDb();
    const [row] = await db
      .select()
      .from(verificationCodes)
      .where(and(eq(verificationCodes.code, code), eq(verificationCodes.channel, channel), gte(verificationCodes.expiresAt, new Date())))
      .orderBy(desc(verificationCodes.createdAt))
      .limit(1);
    if (!row) throw new HttpError(400, 'Invalid or expired code');
    res.json({ ok: true });
  }),
);

export default router;
