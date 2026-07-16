import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { agendaItems, doctors, rosterPatients } from '../db/schema';
import { asyncHandler } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireRole('Doctor', 'Admin'));

/** Resolve the doctor profile linked to the signed-in doctor user (if any). */
async function doctorIdFor(userId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(doctors).where(eq(doctors.userId, userId));
  return row?.id ?? null;
}

/** GET /practice/patients — the doctor's patient roster. */
router.get(
  '/patients',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    const rows = docId
      ? await db.select().from(rosterPatients).where(eq(rosterPatients.doctorId, docId))
      : await db.select().from(rosterPatients);

    res.json(
      rows.map((p) => ({
        id: p.id,
        name: p.name,
        age: p.age,
        gender: p.gender,
        condition: p.condition,
        lastVisit: p.lastVisit,
      })),
    );
  }),
);

/** GET /practice/agenda — the doctor's agenda for the day. */
router.get(
  '/agenda',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    const rows = docId
      ? await db.select().from(agendaItems).where(eq(agendaItems.doctorId, docId))
      : await db.select().from(agendaItems);

    res.json(rows.map((a) => ({ id: a.id, name: a.name, type: a.type, time: a.time, status: a.status })));
  }),
);

export default router;
