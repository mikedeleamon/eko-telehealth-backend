import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appointments, doctors, type AppointmentRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

/** Map a DB row to the Appointment contract. */
function toAppointment(a: AppointmentRow) {
  return {
    id: a.id,
    doctor: a.doctorName,
    specialty: a.specialty,
    date: a.date,
    time: a.time,
    type: a.type,
    status: a.status,
  };
}

/** GET /appointments — the signed-in user's appointments. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.patientId, req.user!.id))
      .orderBy(desc(appointments.createdAt));
    res.json(rows.map(toAppointment));
  }),
);

/** POST /appointments — book (supports dependentId for proxy booking). */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        doctorId: z.string().uuid(),
        date: z.string().min(1),
        time: z.string().min(1),
        type: z.enum(['Video Visit', 'Clinic Visit', 'Home Visit']),
        reason: z.string().optional(),
        dependentId: z.string().optional(),
      })
      .parse(req.body);

    const db = getDb();
    const [doctor] = await db.select().from(doctors).where(eq(doctors.id, input.doctorId));
    if (!doctor) throw new HttpError(404, 'Doctor not found');

    const [row] = await db
      .insert(appointments)
      .values({
        patientId: req.user!.id,
        doctorId: doctor.id,
        doctorName: doctor.name,
        specialty: doctor.category,
        date: input.date,
        time: input.time,
        type: input.type,
        reason: input.reason,
        dependentId: input.dependentId,
        fee: doctor.fee,
        status: 'upcoming',
      })
      .returning();
    res.status(201).json(toAppointment(row!));
  }),
);

/** POST /appointments/:id/cancel */
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [row] = await db
      .update(appointments)
      .set({ status: 'cancelled' })
      .where(and(eq(appointments.id, param(req, 'id')), eq(appointments.patientId, req.user!.id)))
      .returning();
    if (!row) throw new HttpError(404, 'Appointment not found');
    res.json({ ok: true });
  }),
);

export default router;
