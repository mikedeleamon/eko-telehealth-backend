import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { doctors, providerApplications, users } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { isProviderAccountType } from '../lib/providerAccess';
import { APPOINTMENT_PROVIDER_TYPES } from '../lib/providerCapabilities';

const router = Router();
router.use(requireAuth);

const providerTypeSchema = z.enum(['Doctor', 'Nurse', 'Pharmacy', 'Lab', 'Therapist', 'Clinic']);

/**
 * Whether a provider TYPE has a live entity beyond the direct `doctors`
 * lookup above — only reached when that lookup came up empty. Doctor/Nurse/
 * Therapist all resolve here today (redundantly re-checking `doctors` for
 * the appointment-based types, harmless — the primary lookup above already
 * covers them since it's not filtered by type); Pharmacy gets its own case
 * once its `pharmacies` table exists (Phase 3). Mirrors admin.ts's
 * createEntityForApproval — an application can be 'approved' with no live
 * entity yet if its type has no handler.
 */
async function findLiveProviderEntity(userId: string, applicationType: string): Promise<{ id: string } | null> {
  if ((APPOINTMENT_PROVIDER_TYPES as readonly string[]).includes(applicationType)) {
    const db = getDb();
    const [profile] = await db.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, userId));
    return profile ?? null;
  }
  return null;
}

/**
 * GET /providers/me — the signed-in provider's onboarding state.
 *
 * Drives the provider dashboard: an account is not bookable until an
 * application is approved AND its type's entity exists, so the app needs to
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

    // A doctors row always wins (covers seeded/legacy profiles with no
    // matching application row); otherwise fall back to a per-type check
    // keyed on the application's provider type.
    const liveEntity = profile ?? (application ? await findLiveProviderEntity(req.user!.id, application.type) : null);

    res.json({
      // 'live' | 'pending' | 'rejected' | 'none'
      state: liveEntity ? 'live' : (application?.status === 'approved' ? 'pending' : application?.status ?? 'none'),
      doctorId: liveEntity?.id ?? null,
      // Only meaningful once live — drives client-side capability UX
      // (real enforcement is server-side, see lib/providerCapabilities.ts).
      providerType: profile?.providerType ?? null,
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
        // Defaults to 'Doctor'. Mobile's apply-flow type picker (Batch 3
        // Phase 2) only ever sends Doctor/Nurse/Therapist — Pharmacy/Lab/
        // Clinic are admin-created, never self-applied from the app.
        type: providerTypeSchema.optional().default('Doctor'),
        specialty: z.string().min(2),
        category: z.string().min(2),
        location: z.string().min(2),
        fee: z.string().min(1),
        // At least one — patients search by shared language (task 2.5), so
        // an applicant with none would never be findable that way.
        spokenLanguages: z.array(z.string()).min(1),
        // Verification docs, already uploaded to R2 via POST /uploads/presign
        // (kind:'provider-doc') before this submit call — not required, the
        // admin still makes the approve/reject call either way.
        documents: z
          .array(
            z.object({
              key: z.string().min(1),
              fileName: z.string().min(1),
              mimeType: z.string().min(1),
              sizeBytes: z.number().int().positive(),
            }),
          )
          .optional()
          .default([]),
      })
      .parse(req.body);

    if (!isProviderAccountType(req.user!.accountType)) {
      throw new HttpError(403, 'Only provider accounts can apply.');
    }

    const db = getDb();
    // Therapist/Nurse also land in `doctors` (see db/schema.ts's
    // providerType discriminator), so this check already covers them once
    // that lands — only Pharmacy (a separate `pharmacies` table) will need
    // its own liveness check added alongside this one.
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
    const displayName = user
      ? input.type === 'Doctor'
        ? `Dr. ${user.firstName} ${user.lastName}`
        : `${user.firstName} ${user.lastName}`
      : input.type;
    const [row] = await db
      .insert(providerApplications)
      .values({
        userId: req.user!.id,
        // Display name for the queue and, on approval, the entity created for it.
        name: displayName,
        type: input.type,
        specialty: input.specialty,
        category: input.category,
        fee: input.fee,
        location: input.location,
        spokenLanguages: input.spokenLanguages,
        // Server-stamped, not client-supplied — trust our own presign timing.
        documents: input.documents.map((d) => ({ ...d, uploadedAt: new Date().toISOString() })),
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
