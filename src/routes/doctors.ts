import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { doctors, type DoctorRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';

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

export default router;
