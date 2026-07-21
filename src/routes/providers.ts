import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { doctors, providerApplications, users } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

/**
 * GET /providers/me — the signed-in provider's onboarding state.
 *
 * Drives the doctor dashboard: a Doctor account is not bookable until an
 * application is approved and a `doctors` profile exists, so the app needs to
 * tell "no application yet" from "waiting on review" from "live".
 */
router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [profile] = await db.select().from(doctors).where(eq(doctors.userId, req.user!.id));
    const [application] = await db
      .select()
      .from(providerApplications)
      .where(eq(providerApplications.userId, req.user!.id))
      .orderBy(desc(providerApplications.createdAt))
      .limit(1);

    res.json({
      // 'live' | 'pending' | 'rejected' | 'none'
      state: profile ? 'live' : (application?.status === 'approved' ? 'pending' : application?.status ?? 'none'),
      doctorId: profile?.id ?? null,
      application: application
        ? { id: application.id, status: application.status, submittedAt: application.submittedAt }
        : null,
    });
  }),
);

/**
 * POST /providers/apply — submit a provider application for admin review.
 *
 * Deliberately does NOT create a bookable profile: approval in the admin
 * console does that (see POST /admin/providers/applications/:id/decision).
 * Vetting is the point — an unreviewed stranger must never be bookable as a
 * doctor.
 */
router.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        specialty: z.string().min(2),
        category: z.string().min(2),
        location: z.string().min(2),
        fee: z.string().min(1),
        // At least one — patients search by shared language (task 2.5), so
        // an applicant with none would never be findable that way.
        spokenLanguages: z.array(z.string()).min(1),
      })
      .parse(req.body);

    if (req.user!.accountType !== 'Doctor') {
      throw new HttpError(403, 'Only accounts registered as a Doctor can apply.');
    }

    const db = getDb();
    const [profile] = await db.select().from(doctors).where(eq(doctors.userId, req.user!.id));
    if (profile) throw new HttpError(409, 'Your provider profile is already live.');

    const [pending] = await db
      .select()
      .from(providerApplications)
      .where(eq(providerApplications.userId, req.user!.id))
      .orderBy(desc(providerApplications.createdAt))
      .limit(1);
    if (pending?.status === 'pending') {
      throw new HttpError(409, 'Your application is already under review.');
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.user!.id));
    const [row] = await db
      .insert(providerApplications)
      .values({
        userId: req.user!.id,
        // Display name for the queue and, on approval, the doctors row.
        name: user ? `Dr. ${user.firstName} ${user.lastName}` : 'Doctor',
        type: 'Doctor',
        specialty: input.specialty,
        category: input.category,
        fee: input.fee,
        location: input.location,
        spokenLanguages: input.spokenLanguages,
        submittedAt: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        // The admin verifies these; email is implicitly checked at signup.
        checkEmail: true,
        status: 'pending',
      })
      .returning();

    res.status(201).json({ id: row!.id, status: row!.status, submittedAt: row!.submittedAt });
  }),
);

export default router;
