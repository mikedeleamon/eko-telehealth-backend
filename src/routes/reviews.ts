import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appointments, reviews, users } from '../db/schema';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { isProviderAccountType } from '../lib/providerAccess';

const router = Router();

/** Map a row to the shape the mobile review cards render. */
function toReview(r: typeof reviews.$inferSelect) {
  return {
    id: r.id,
    author: r.author,
    rating: r.rating,
    text: r.text,
    date: r.submittedAt,
    title: r.title ?? undefined,
    verified: r.verified,
    comments: r.commentsCount,
    communicationRating: r.communicationRating ?? undefined,
    experienceRating: r.experienceRating ?? undefined,
    speedyResponseRating: r.speedyResponseRating ?? undefined,
  };
}

/**
 * GET /reviews?subject= — published reviews, optionally for one subject
 * (a doctor's display name). Only 'published' rows are public: submissions
 * start 'pending' and go live through the admin moderation queue.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
    const db = getDb();
    const rows = await db
      .select()
      .from(reviews)
      .where(
        subject
          ? and(eq(reviews.status, 'published'), eq(reviews.subject, subject))
          : eq(reviews.status, 'published'),
      )
      .orderBy(desc(reviews.createdAt));
    res.json(rows.map(toReview));
  }),
);

/**
 * GET /reviews/summary?subject= — average + total + per-star distribution over
 * published reviews. Powers the App Store-style summary header; computed over
 * the same 'published' rows the list returns so the numbers always agree.
 */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const subject = typeof req.query.subject === 'string' ? req.query.subject : undefined;
    const db = getDb();
    const rows = await db
      .select({ rating: reviews.rating })
      .from(reviews)
      .where(
        subject
          ? and(eq(reviews.status, 'published'), eq(reviews.subject, subject))
          : eq(reviews.status, 'published'),
      );

    const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    let sum = 0;
    for (const r of rows) {
      const star = Math.min(5, Math.max(1, Math.round(r.rating)));
      distribution[star - 1] += 1;
      sum += r.rating;
    }
    const total = rows.length;
    const average = total ? Math.round((sum / total) * 10) / 10 : 0;
    res.json({ average, total, distribution });
  }),
);

/**
 * POST /reviews — submit a review for moderation. Author and direction come
 * from the session (never the body), so a review can't be forged on someone
 * else's behalf; it lands in the admin queue as 'pending'.
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { subject, communicationRating, experienceRating, speedyResponseRating, text, title } = z
      .object({
        subject: z.string().min(1),
        communicationRating: z.number().int().min(1).max(5),
        experienceRating: z.number().int().min(1).max(5),
        speedyResponseRating: z.number().int().min(1).max(5),
        text: z.string().min(3),
        title: z.string().max(80).optional(),
      })
      .parse(req.body);
    // Overall score is derived, not picked separately — see the schema note
    // on reviews.rating.
    const rating = Math.round((communicationRating + experienceRating + speedyResponseRating) / 3);

    const db = getDb();
    const [author] = await db.select().from(users).where(eq(users.id, req.user!.id));
    const authorName = author ? `${author.firstName} ${author.lastName}` : req.user!.email;
    const submittedAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // "Verified patient" = the author actually had an appointment with the
    // subject. Cheap existence check against their own appointments.
    const [priorVisit] = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.patientId, req.user!.id), eq(appointments.doctorName, subject)))
      .limit(1);

    const [row] = await db
      .insert(reviews)
      .values({
        author: authorName,
        subject,
        direction: isProviderAccountType(req.user!.accountType) ? 'provider→patient' : 'patient→provider',
        rating,
        communicationRating,
        experienceRating,
        speedyResponseRating,
        title: title ?? null,
        text,
        verified: !!priorVisit,
        submittedAt,
        status: 'pending',
      })
      .returning();
    res.status(201).json(toReview(row!));
  }),
);

export default router;
