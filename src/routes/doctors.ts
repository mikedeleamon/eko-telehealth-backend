import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { doctors, type DoctorRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { findNextAvailable, getAvailableSlots } from '../services/availability';

const router = Router();

/** Map a DB row to the Doctor contract (eko_telehealth/src/api/types.ts). */
function toDoctor(d: DoctorRow) {
  return {
    id: d.id,
    name: d.name,
    specialty: d.specialty,
    category: d.category,
    rating: d.rating,
    reviews: d.reviews,
    location: d.location,
    fee: d.fee,
    available: d.available,
    nextAvailable: d.nextAvailable,
    avatar: d.avatar,
    canProvideInHome: d.canProvideInHome,
    spokenLanguages: d.spokenLanguages,
  };
}

/** GET /doctors?category=&query= — public provider search. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const query = typeof req.query.query === 'string' ? req.query.query.toLowerCase() : undefined;

    const db = getDb();
    let rows = await db.select().from(doctors);
    if (category) rows = rows.filter((d) => d.category === category);
    if (query) {
      rows = rows.filter(
        (d) => d.name.toLowerCase().includes(query) || d.specialty.toLowerCase().includes(query),
      );
    }
    res.json(rows.map(toDoctor));
  }),
);

/**
 * GET /doctors/match?category=&type= — the earliest open slot across every
 * eligible doctor in a category ("Book Next Available" / flexible provider
 * selection). Public, same as GET /doctors. A no-match result is a normal
 * empty outcome (nobody free in the window), never a 404.
 *
 * Registered before GET /:id — otherwise Express's greedy `/:id` pattern
 * would swallow this path first, treating "match" as a doctor id.
 */
router.get(
  '/match',
  asyncHandler(async (req, res) => {
    const { category, type } = z
      .object({
        category: z.string().min(1),
        type: z.enum(['Video Visit', 'Clinic Visit', 'Home Visit']),
      })
      .parse(req.query);
    const match = await findNextAvailable(category, type);
    if (!match) {
      res.json({ doctor: null, slot: null });
      return;
    }
    res.json({ doctor: toDoctor(match.doctor), slot: match.slot });
  }),
);

/** GET /doctors/:id */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db.select().from(doctors).where(eq(doctors.id, param(req, 'id')));
    if (!row) throw new HttpError(404, 'Doctor not found');
    res.json(toDoctor(row));
  }),
);

/**
 * GET /doctors/:id/availability?date=YYYY-MM-DD — public, same as GET
 * /doctors. Replaces the mobile app's old hardcoded slot list. An empty
 * `slots` array just means the doctor doesn't work that day — not an error.
 */
router.get(
  '/:id/availability',
  asyncHandler(async (req, res) => {
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    const db = getDb();
    const [doctor] = await db.select({ id: doctors.id }).from(doctors).where(eq(doctors.id, param(req, 'id')));
    if (!doctor) throw new HttpError(404, 'Doctor not found');
    const slots = await getAvailableSlots(doctor.id, date);
    res.json({ date, slots });
  }),
);

export default router;
