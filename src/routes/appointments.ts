import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appointments, dependents, doctors, type AppointmentRow } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { formatLagosClockTime, formatLagosDate } from '../lib/timezone';
import { requireAuth } from '../middleware/auth';
import { isSlotAvailable } from '../services/availability';
import { notify } from '../services/notify';

const router = Router();
router.use(requireAuth);

/** Map a DB row to the Appointment contract. */
export function toAppointment(a: AppointmentRow) {
  return {
    id: a.id,
    doctor: a.doctorName,
    specialty: a.specialty,
    date: a.date,
    time: a.time,
    startAt: a.startAt?.toISOString(),
    type: a.type,
    status: a.status,
    fee: a.fee ?? undefined,
    declineReason: a.declineReason ?? undefined,
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

/**
 * POST /appointments — request a visit (supports dependentId for proxy booking).
 *
 * Creates a REQUEST, not a booking: the row starts 'pending_approval' and only
 * becomes 'upcoming' after the doctor accepts and a verified payment webhook
 * confirms. Nothing here is trusted to confirm a visit.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        doctorId: z.string().uuid(),
        /** ISO instant — a slot returned by GET /doctors/:id/availability, re-validated below. */
        startAt: z.string().min(1),
        type: z.enum(['Video Visit', 'Clinic Visit', 'Home Visit']),
        reason: z.string().optional(),
        dependentId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const startAt = new Date(input.startAt);
    if (Number.isNaN(startAt.getTime())) throw new HttpError(400, 'Invalid start time.');

    const db = getDb();
    const [doctor] = await db.select().from(doctors).where(eq(doctors.id, input.doctorId));
    if (!doctor) throw new HttpError(404, 'Doctor not found');
    // In-home care is an admin-granted privilege (task 2.3) — checked here,
    // not just hidden in the booking UI, so a request can't be forged past it.
    if (input.type === 'Home Visit' && !doctor.canProvideInHome) {
      throw new HttpError(409, `${doctor.name} is not certified for home visits.`);
    }

    // A dependent must belong to the caller, or anyone could book against
    // someone else's dependent id.
    if (input.dependentId) {
      const [dep] = await db
        .select()
        .from(dependents)
        .where(and(eq(dependents.id, input.dependentId), eq(dependents.userId, req.user!.id)));
      if (!dep) throw new HttpError(404, 'Dependent not found');
    }

    // Re-validated server-side against the doctor's real availability — a
    // hand-crafted request must not be able to book a time that was never a
    // real generated slot (e.g. misaligned minutes, or one already taken).
    if (!(await isSlotAvailable(doctor.id, startAt))) {
      throw new HttpError(409, 'This time is no longer available. Please pick another slot.');
    }

    const date = formatLagosDate(startAt);
    const time = formatLagosClockTime(startAt);

    let row: AppointmentRow;
    try {
      [row] = await db
        .insert(appointments)
        .values({
          patientId: req.user!.id,
          doctorId: doctor.id,
          doctorName: doctor.name,
          specialty: doctor.category,
          date,
          time,
          startAt,
          type: input.type,
          reason: input.reason,
          dependentId: input.dependentId,
          fee: doctor.fee,
          status: 'pending_approval',
        })
        .returning();
    } catch (err) {
      // The partial unique index (migrations/0013) is the race-condition
      // backstop for two requests landing on the same slot in the same
      // instant — isSlotAvailable() above already caught the common case.
      if ((err as { code?: string }).code === '23505') {
        throw new HttpError(409, 'This slot was just booked — pick another.');
      }
      throw err;
    }

    await notify(
      req.user!.id,
      'Request Sent',
      `Your ${input.type.toLowerCase()} request to ${doctor.name} for ${date} at ${time} is awaiting approval.`,
    );
    if (doctor.userId) {
      await notify(
        doctor.userId,
        'New Appointment Request',
        `A patient requested a ${input.type.toLowerCase()} on ${date} at ${time}.`,
      );
    }

    res.status(201).json(toAppointment(row!));
  }),
);

/**
 * POST /appointments/:id/check-in — patient marks themselves present/ready
 * ahead of the visit (E-Check-In). Only from 'upcoming' — a request that
 * hasn't been paid for/confirmed yet, or a visit that's already over, can't
 * be checked into.
 */
router.post(
  '/:id/check-in',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [existing] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, param(req, 'id')), eq(appointments.patientId, req.user!.id)));
    if (!existing) throw new HttpError(404, 'Appointment not found');
    if (existing.status !== 'upcoming') {
      throw new HttpError(409, `This appointment can't be checked into right now (it is ${existing.status}).`);
    }

    const [row] = await db
      .update(appointments)
      .set({ status: 'checked_in' })
      .where(eq(appointments.id, existing.id))
      .returning();

    res.json(toAppointment(row!));
  }),
);

/**
 * POST /appointments/:id/cancel — patient-side cancellation.
 *
 * Allowed while a visit is still ahead (requested, awaiting payment, or
 * confirmed); a past/declined/already-cancelled row can't be cancelled again.
 */
router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [existing] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.id, param(req, 'id')), eq(appointments.patientId, req.user!.id)));
    if (!existing) throw new HttpError(404, 'Appointment not found');
    if (!['pending_approval', 'pending_payment', 'upcoming'].includes(existing.status)) {
      throw new HttpError(409, `This appointment can no longer be cancelled (it is ${existing.status}).`);
    }

    const [row] = await db
      .update(appointments)
      .set({ status: 'cancelled' })
      .where(eq(appointments.id, existing.id))
      .returning();
    if (!row) throw new HttpError(404, 'Appointment not found');

    await notify(
      req.user!.id,
      'Appointment Cancelled',
      `Your appointment with ${row.doctorName} on ${row.date} was cancelled.`,
    );
    if (row.doctorId) {
      const [doctor] = await db.select().from(doctors).where(eq(doctors.id, row.doctorId));
      if (doctor?.userId) {
        await notify(
          doctor.userId,
          'Appointment Cancelled',
          `The ${row.date} ${row.time} appointment was cancelled by the patient.`,
        );
      }
    }

    res.json({ ok: true });
  }),
);

export default router;
