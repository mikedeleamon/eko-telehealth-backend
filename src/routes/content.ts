import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { contentBlocks } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';

const router = Router();

/** Map a row to the shape the app renders. */
function toBlock(c: typeof contentBlocks.$inferSelect) {
  return { key: c.key, title: c.title, body: c.body };
}

/**
 * GET /content — every content block, for screens that render several at
 * once (AboutUsScreen). Public — this is marketing/legal copy, not account
 * data. Admin-only editing lives at /admin/content.
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(contentBlocks);
    res.json(rows.map(toBlock));
  }),
);

/** GET /content/:key — a single block (TermsOfServiceScreen, PrivacyPolicyScreen). */
router.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db.select().from(contentBlocks).where(eq(contentBlocks.key, param(req, 'key')));
    if (!row) throw new HttpError(404, 'Content block not found');
    res.json(toBlock(row));
  }),
);

export default router;
