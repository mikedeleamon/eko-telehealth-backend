import { Router } from 'express';
import { and, count, desc, eq, gte, inArray, sum } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appointments, doctors, payments, providerApplications, reviews, users } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { formatJoined, formatNaira } from '../lib/format';
import { requireAuth, requireAccountType } from '../middleware/auth';
import { notify } from '../services/notify';

const router = Router();
// NOTE: the admin site still needs a login screen (integration guide, Step 5).
// Until then, sign in via POST /auth/login with the seeded Admin account to get
// a token; this guard already enforces the Admin account type on every admin route.
router.use(requireAuth, requireAccountType('Admin'));

/** GET /admin/stats — dashboard counters. */
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [[patients], [providers], [weekAppts], [revenue], [pendingVer], [pendingRev]] = await Promise.all([
      db.select({ value: count() }).from(users).where(eq(users.accountType, 'Patient')),
      db.select({ value: count() }).from(doctors),
      db.select({ value: count() }).from(appointments).where(gte(appointments.createdAt, weekAgo)),
      db
        .select({ value: sum(payments.amount) })
        .from(payments)
        .where(and(eq(payments.status, 'succeeded'), eq(payments.currency, 'NGN'))),
      db.select({ value: count() }).from(providerApplications).where(eq(providerApplications.status, 'pending')),
      db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
    ]);

    res.json({
      totalPatients: patients?.value ?? 0,
      activeProviders: providers?.value ?? 0,
      appointmentsThisWeek: weekAppts?.value ?? 0,
      revenueThisMonth: formatNaira(Number(revenue?.value ?? 0)),
      pendingVerifications: pendingVer?.value ?? 0,
      pendingReviews: pendingRev?.value ?? 0,
    });
  }),
);

/** GET /admin/providers/applications — verification queue. */
router.get(
  '/providers/applications',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(providerApplications);
    res.json(
      rows.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        specialty: a.specialty,
        location: a.location,
        submittedAt: a.submittedAt,
        checks: { govId: a.checkGovId, email: a.checkEmail, phone: a.checkPhone },
        status: a.status,
      })),
    );
  }),
);

/**
 * POST /admin/providers/applications/:id/decision
 *
 * Approving a Doctor application is what actually creates the bookable
 * `doctors` row and links it to the applicant's account — this is the only
 * path from "signed up as a Doctor" to "appears in search". Idempotent: a
 * second approval won't create a duplicate profile.
 */
router.post(
  '/providers/applications/:id/decision',
  asyncHandler(async (req, res) => {
    const { decision } = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body);
    const db = getDb();
    const [row] = await db
      .update(providerApplications)
      .set({ status: decision })
      .where(eq(providerApplications.id, param(req, 'id')))
      .returning();
    if (!row) throw new HttpError(404, 'Application not found');

    let doctorId: string | undefined;
    if (decision === 'approved' && row.type === 'Doctor' && row.userId) {
      const [existing] = await db.select().from(doctors).where(eq(doctors.userId, row.userId));
      if (existing) {
        doctorId = existing.id;
      } else {
        const [created] = await db
          .insert(doctors)
          .values({
            userId: row.userId,
            name: row.name,
            specialty: row.specialty,
            category: row.category ?? row.specialty,
            location: row.location,
            fee: row.fee ?? '₦15,000',
            available: true,
            nextAvailable: '',
          })
          .returning();
        doctorId = created!.id;
      }
      await notify(
        row.userId,
        'Application Approved',
        'Your provider application was approved — your profile is now live and patients can book you.',
      );
    } else if (decision === 'rejected' && row.userId) {
      await notify(
        row.userId,
        'Application Not Approved',
        'Your provider application was not approved. Contact support if you think this is a mistake.',
      );
    }

    res.json({ ok: true, doctorId });
  }),
);

/** GET /admin/reviews?status=pending — moderation queue. */
router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const db = getDb();
    const rows = await db
      .select()
      .from(reviews)
      .where(eq(reviews.status, status as 'pending' | 'published' | 'removed'));
    res.json(rows);
  }),
);

/** POST /admin/reviews/:id/decision */
router.post(
  '/reviews/:id/decision',
  asyncHandler(async (req, res) => {
    const { decision } = z.object({ decision: z.enum(['published', 'removed']) }).parse(req.body);
    const db = getDb();
    const [row] = await db.update(reviews).set({ status: decision }).where(eq(reviews.id, param(req, 'id'))).returning();
    if (!row) throw new HttpError(404, 'Review not found');
    res.json({ ok: true });
  }),
);

/** GET /admin/users — user management. */
router.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(inArray(users.accountType, ['Patient', 'Doctor']))
      .orderBy(desc(users.joinedAt));
    res.json(
      rows.map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`,
        email: u.email,
        accountType: u.accountType,
        joined: formatJoined(u.joinedAt),
        status: u.status,
      })),
    );
  }),
);

/** GET /admin/appointments — all bookings. */
router.get(
  '/appointments',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db
      .select({ appt: appointments, patient: users })
      .from(appointments)
      .leftJoin(users, eq(users.id, appointments.patientId))
      .orderBy(desc(appointments.createdAt));

    res.json(
      rows.map(({ appt, patient }) => ({
        id: appt.id,
        patient: patient ? `${patient.firstName} ${patient.lastName}` : 'Unknown',
        provider: appt.doctorName,
        type: appt.type,
        date: `${appt.date} · ${appt.time}`,
        fee: appt.fee ?? '',
        status: appt.status === 'past' ? 'completed' : appt.status,
      })),
    );
  }),
);

export default router;
