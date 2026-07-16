import { Router } from 'express';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { users, verificationCodes, type UserRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { signSession } from '../lib/jwt';
import { hashPassword, verifyPassword } from '../lib/password';
import { requireAuth } from '../middleware/auth';
import { sendEmail } from '../services/email';
import { normalizeMsisdn, sendSms } from '../services/sms';

const router = Router();
const roleSchema = z.enum(['Patient', 'Doctor']);
const channelSchema = z.enum(['email', 'sms']);

/** Wrong guesses allowed against a destination before its codes are burned. */
const MAX_CODE_ATTEMPTS = 5;
/** Codes a single destination may be sent inside CODE_WINDOW_MS. */
const MAX_CODES_PER_WINDOW = 5;
const CODE_WINDOW_MS = 15 * 60 * 1000;

/**
 * One canonical form per channel: phones become MSISDNs (matching users.phone),
 * emails lowercase. Codes are stored under this value, so issuing and checking
 * must both route through it or a code becomes unfindable.
 */
function normalizeDestination(destination: string, channel: 'email' | 'sms'): string {
  return channel === 'sms' ? normalizeMsisdn(destination) : destination.toLowerCase();
}

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
        // Optional so seeded/admin accounts (which have none) stay valid; the
        // mobile signup form always sends one. Without it, SMS reset can't
        // resolve the account and the user must reset by email.
        phone: z.string().min(7).optional(),
      })
      .parse(req.body);

    const db = getDb();
    const email = input.email.toLowerCase();
    const phone = input.phone ? normalizeMsisdn(input.phone) : null;

    const [existing] = await db.select().from(users).where(eq(users.email, email));
    if (existing) throw new HttpError(409, 'An account with this email already exists.');
    if (phone) {
      // Enforced here as well as by the unique index, so the caller gets a
      // useful message instead of a raw constraint violation.
      const [taken] = await db.select().from(users).where(eq(users.phone, phone));
      if (taken) throw new HttpError(409, 'An account with this phone number already exists.');
    }

    const [user] = await db
      .insert(users)
      .values({
        firstName: input.firstName,
        lastName: input.lastName,
        email,
        phone,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      })
      .returning();
    res.status(201).json(sessionResponse(user!));
  }),
);

/** Generate a 6-digit code, store it, and deliver it over the given channel. */
async function issueCode(destination: string, channel: 'email' | 'sms'): Promise<void> {
  const db = getDb();
  const dest = normalizeDestination(destination, channel);

  // Throttle per destination. This caps OTP spam and Termii spend (each SMS
  // costs real money), and together with MAX_CODE_ATTEMPTS bounds an attacker
  // to MAX_CODES_PER_WINDOW * MAX_CODE_ATTEMPTS guesses per window.
  const recent = await db
    .select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.destination, dest),
        gte(verificationCodes.createdAt, new Date(Date.now() - CODE_WINDOW_MS)),
      ),
    );
  if (recent.length >= MAX_CODES_PER_WINDOW) {
    throw new HttpError(429, 'Too many codes requested. Please wait a few minutes and try again.');
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.insert(verificationCodes).values({
    destination: dest,
    channel,
    code,
    expiresAt: new Date(Date.now() + CODE_WINDOW_MS),
  });
  const text = `Your Eko Telehealth verification code is ${code}. It expires in 15 minutes.`;
  if (channel === 'sms') {
    await sendSms(dest, text);
  } else {
    await sendEmail(dest, 'Your Eko Telehealth verification code', `<p>${text}</p>`);
  }
}

/**
 * Check a submitted code against the live codes for a destination, charging
 * failed guesses. Returns the matching row; throws 400 for a bad code and 429
 * once MAX_CODE_ATTEMPTS is spent (burning the codes, forcing a new request).
 */
async function checkCode(destination: string, channel: 'email' | 'sms', code: string) {
  const db = getDb();
  const live = await db
    .select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.destination, destination),
        eq(verificationCodes.channel, channel),
        gte(verificationCodes.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(verificationCodes.createdAt));

  const match = live.find((row) => row.code === code);
  if (match) return match;

  if (live.length) {
    // Charge the guess against the destination rather than a single row, so
    // requesting a fresh code can't hand back a clean slate of attempts.
    const attempts = Math.max(...live.map((row) => row.attempts)) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await db.delete(verificationCodes).where(eq(verificationCodes.destination, destination));
      throw new HttpError(429, 'Too many incorrect attempts. Request a new code.');
    }
    await db
      .update(verificationCodes)
      .set({ attempts })
      .where(eq(verificationCodes.destination, destination));
  }
  throw new HttpError(400, 'Invalid or expired code');
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

/**
 * POST /auth/verify — email / SMS OTP check.
 *
 * A UI gate (it grants nothing on its own — /auth/reset-password re-checks the
 * code), but still bound to its destination: it previously matched ANY live
 * code for the channel, so a code issued to one address verified another.
 * Deliberately does NOT consume the code — the reset step still needs it.
 */
router.post(
  '/verify',
  asyncHandler(async (req, res) => {
    const { channel, destination, code } = z
      .object({ channel: channelSchema, destination: z.string().min(1), code: z.string().min(4) })
      .parse(req.body);
    await checkCode(normalizeDestination(destination, channel), channel, code);
    res.json({ ok: true });
  }),
);

/**
 * POST /auth/reset-password — set a new password using a code from
 * /auth/forgot-password (email) or /auth/send-code (sms).
 *
 * Anonymous by necessity (the user can't sign in), so the delivered code IS the
 * proof of identity. That makes the destination binding load-bearing: the code
 * must have been issued to the very address/number being reset, or a code
 * minted for an attacker's own destination would reset anybody's account.
 */
router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const { channel, destination, code, newPassword } = z
      .object({
        channel: channelSchema,
        destination: z.string().min(1),
        code: z.string().min(4),
        // Matches the minimum enforced at signup.
        newPassword: z.string().min(6),
      })
      .parse(req.body);

    const db = getDb();
    const dest = normalizeDestination(destination, channel);

    await checkCode(dest, channel, code);

    const [user] = await db
      .select()
      .from(users)
      .where(channel === 'sms' ? eq(users.phone, dest) : eq(users.email, dest));
    // Same 400 as a bad code: /auth/forgot-password deliberately never reveals
    // whether a destination is registered, and this must not undo that.
    if (!user) throw new HttpError(400, 'Invalid or expired code');
    if (user.status === 'suspended') throw new HttpError(403, 'This account has been suspended.');

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, user.id));

    // Burn every outstanding code for the destination, not just the one used,
    // so a second code from a repeated request can't replay the reset.
    await db.delete(verificationCodes).where(eq(verificationCodes.destination, dest));

    res.json({ ok: true });
  }),
);

/**
 * PATCH /auth/me — update the signed-in user's profile.
 *
 * Email is deliberately NOT updatable here: it's the login identifier and the
 * password-reset destination, so changing it must go through a verified-email
 * flow, not a profile save.
 */
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        firstName: z.string().min(1).optional(),
        lastName: z.string().min(1).optional(),
        phone: z.string().min(7).optional(),
      })
      .parse(req.body);

    const db = getDb();
    const updates: Partial<{ firstName: string; lastName: string; phone: string }> = {};
    if (input.firstName) updates.firstName = input.firstName;
    if (input.lastName) updates.lastName = input.lastName;
    if (input.phone) {
      const phone = normalizeMsisdn(input.phone);
      const [taken] = await db.select().from(users).where(eq(users.phone, phone));
      if (taken && taken.id !== req.user!.id) {
        throw new HttpError(409, 'An account with this phone number already exists.');
      }
      updates.phone = phone;
    }
    if (!Object.keys(updates).length) throw new HttpError(400, 'Nothing to update.');

    const [user] = await db.update(users).set(updates).where(eq(users.id, req.user!.id)).returning();
    if (!user) throw new HttpError(401, 'Session expired or invalid');
    res.json({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
    });
  }),
);

/**
 * POST /auth/change-password — password change for a signed-in user.
 *
 * Requires the current password: an access token alone must not be enough to
 * lock the owner out of their own account.
 */
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(6) })
      .parse(req.body);

    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!user) throw new HttpError(401, 'Session expired or invalid');
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new HttpError(400, 'Your current password is incorrect.');
    }

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, user.id));

    res.json({ ok: true });
  }),
);

export default router;
