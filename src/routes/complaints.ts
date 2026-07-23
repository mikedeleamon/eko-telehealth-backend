import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appointments, complaints, users, type ComplaintRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { isProviderAccountType } from '../lib/providerAccess';

const router = Router();
router.use(requireAuth);

/** Map a row to the shape the app's Report a Problem screen renders. */
function toComplaint(c: ComplaintRow) {
  return {
    id: c.id,
    category: c.category,
    subject: c.subject,
    description: c.description,
    status: c.status,
    resolutionNote: c.resolutionNote ?? undefined,
    submittedAt: c.submittedAt,
  };
}

/** GET /complaints — the signed-in user's own filed reports, newest first. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(complaints)
      .where(eq(complaints.userId, req.user!.id))
      .orderBy(desc(complaints.createdAt));
    res.json(rows.map(toComplaint));
  }),
);

/**
 * POST /complaints — file a report for admin review.
 *
 * Author identity comes from the session (never the body), mirroring
 * routes/reviews.ts — a complaint can't be filed on someone else's behalf.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        category: z.enum(['billing', 'appointment', 'provider', 'technical', 'other']),
        subject: z.string().min(2).max(120),
        description: z.string().min(10),
        appointmentId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const db = getDb();

    // If a visit is named, it must actually be this user's — otherwise
    // anyone could attach their report to a stranger's appointment.
    if (input.appointmentId) {
      const [appt] = await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(and(eq(appointments.id, input.appointmentId), eq(appointments.patientId, req.user!.id)));
      if (!appt) throw new HttpError(404, 'Appointment not found');
    }

    const [author] = await db.select().from(users).where(eq(users.id, req.user!.id));
    const authorName = author ? `${author.firstName} ${author.lastName}` : req.user!.email;
    const submittedAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const [row] = await db
      .insert(complaints)
      .values({
        userId: req.user!.id,
        authorName,
        accountType: isProviderAccountType(req.user!.accountType) ? req.user!.accountType : 'Patient',
        category: input.category,
        subject: input.subject,
        description: input.description,
        appointmentId: input.appointmentId,
        submittedAt,
        status: 'pending',
      })
      .returning();
    res.status(201).json(toComplaint(row!));
  }),
);

export default router;
