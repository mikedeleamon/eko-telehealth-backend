import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { currencies } from '../db/schema';
import { asyncHandler } from '../lib/http';

const router = Router();

/**
 * GET /currencies — active display currencies, for the patient-facing
 * preference picker. Public (no auth) — this is just rate metadata, not
 * account data. Admin-only management lives at /admin/currencies.
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(currencies).where(eq(currencies.active, true));
    res.json(rows.map((c) => ({ code: c.code, symbol: c.symbol, ngnRate: c.ngnRate })));
  }),
);

export default router;
