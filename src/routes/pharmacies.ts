import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { pharmacies } from '../db/schema';
import { asyncHandler } from '../lib/http';

const router = Router();

/**
 * GET /pharmacies — active directory pharmacies, for the patient-facing
 * preferred-pharmacy picker (Batch 3 Phase 3). Public (no auth), same
 * pattern as GET /currencies — this is a browsable directory, not account
 * data. Admin-only management (approval creates rows, active toggle) lives
 * at /admin/providers/applications and /admin/pharmacies/:id.
 */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(pharmacies).where(eq(pharmacies.active, true));
    res.json(rows.map((p) => ({ id: p.id, name: p.name, address: p.address, fax: p.fax })));
  }),
);

export default router;
