import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { reviews, users } from '../db/schema';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';

const router = Router();

/** Map a row to the shape the mobile review cards render. */
function toReview(r: typeof reviews.$inferSelect) {
  return { id: r.id, author: r.author, rating: r.rating, text: r.text, date: r.submittedAt };
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
 * POST /reviews — submit a review for moderation. Author and direction come
 * from the session (never the body), so a review can't be forged on someone
 * else's behalf; it lands in the admin queue as 'pending'.
 */
router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { subject, rating, text } = z
      .object({
        subject: z.string().min(1),
        rating: z.number().int().min(1).max(5),
        text: z.string().min(3),
      })
      .parse(req.body);

    const db = getDb();
    const [author] = await db.select().from(users).where(eq(users.id, req.user!.id));
    const authorName = author ? `${author.firstName} ${author.lastName}` : req.user!.email;
    const submittedAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const [row] = await db
      .insert(reviews)
      .values({
        author: authorName,
        subject,
        direction: req.user!.role === 'Doctor' ? 'provider→patient' : 'patient→provider',
        rating,
        text,
        submittedAt,
        status: 'pending',
      })
      .returning();
    res.status(201).json(toReview(row!));
  }),
);

export default router;
