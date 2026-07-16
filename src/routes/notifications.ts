import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { notifications } from '../db/schema';
import { asyncHandler } from '../lib/http';
import { formatRelative } from '../lib/format';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

/** GET /notifications — the signed-in user's in-app feed. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.user!.id))
      .orderBy(desc(notifications.createdAt));

    res.json(
      rows.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        time: formatRelative(n.createdAt),
      })),
    );
  }),
);

export default router;
