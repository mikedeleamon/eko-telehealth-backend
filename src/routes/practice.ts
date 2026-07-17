import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { agendaItems, appointments, doctors, rosterPatients, users } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { requireAuth, requireRole } from '../middleware/auth';
import { notify } from '../services/notify';
import { toAppointment } from './appointments';

const router = Router();
router.use(requireAuth, requireRole('Doctor', 'Admin'));

/** Resolve the doctor profile linked to the signed-in doctor user (if any). */
async function doctorIdFor(userId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(doctors).where(eq(doctors.userId, userId));
  return row?.id ?? null;
}

/**
 * Load an appointment that belongs to the signed-in doctor's practice.
 * Ownership is enforced here so accept/decline can never touch someone
 * else's appointment.
 */
async function ownedAppointment(userId: string, appointmentId: string) {
  const db = getDb();
  const docId = await doctorIdFor(userId);
  if (!docId) throw new HttpError(403, 'No doctor profile is linked to this account yet.');
  const [row] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.doctorId, docId)));
  if (!row) throw new HttpError(404, 'Appointment not found');
  return row;
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

/**
 * GET /practice/appointments — the doctor's own appointments.
 *
 * Separate from GET /appointments, which is scoped to the signed-in *patient*.
 * The patient's name replaces doctorName in the `doctor` field so the shared
 * appointment card always shows the counterparty.
 */
router.get(
  '/appointments',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    if (!docId) {
      res.json([]); // no linked profile yet — an empty practice, not an error
      return;
    }

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.doctorId, docId))
      .orderBy(desc(appointments.createdAt));

    // Resolve patient names in one query rather than per row.
    const patientIds = [...new Set(rows.map((r) => r.patientId))];
    const patients = patientIds.length
      ? await db.select().from(users).where(inArray(users.id, patientIds))
      : [];
    const nameById = new Map(patients.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));

    res.json(rows.map((r) => ({ ...toAppointment(r), doctor: nameById.get(r.patientId) ?? 'Patient' })));
  }),
);

/**
 * POST /practice/appointments/:id/accept — accept a request.
 * Moves it to 'pending_payment': accepting reserves the slot but does not
 * confirm the visit; only a verified payment webhook does that.
 */
router.post(
  '/appointments/:id/accept',
  asyncHandler(async (req, res) => {
    const existing = await ownedAppointment(req.user!.id, param(req, 'id'));
    if (existing.status !== 'pending_approval') {
      throw new HttpError(409, `Only a pending request can be accepted (this one is ${existing.status}).`);
    }

    const db = getDb();
    const [row] = await db
      .update(appointments)
      .set({ status: 'pending_payment', acceptedAt: new Date() })
      .where(eq(appointments.id, existing.id))
      .returning();

    await notify(
      existing.patientId,
      'Appointment Accepted — Payment Required',
      `${existing.doctorName} accepted your ${existing.date} ${existing.time} request. Pay ${existing.fee ?? 'the fee'} to confirm it.`,
    );
    res.json(toAppointment(row!));
  }),
);

/** POST /practice/appointments/:id/decline — reject a request, with a reason. */
router.post(
  '/appointments/:id/decline',
  asyncHandler(async (req, res) => {
    const { reason } = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {});
    const existing = await ownedAppointment(req.user!.id, param(req, 'id'));
    if (existing.status !== 'pending_approval') {
      throw new HttpError(409, `Only a pending request can be declined (this one is ${existing.status}).`);
    }

    const db = getDb();
    const [row] = await db
      .update(appointments)
      .set({ status: 'declined', declineReason: reason ?? null })
      .where(eq(appointments.id, existing.id))
      .returning();

    await notify(
      existing.patientId,
      'Appointment Declined',
      reason
        ? `${existing.doctorName} could not take your ${existing.date} request: ${reason}`
        : `${existing.doctorName} could not take your ${existing.date} ${existing.time} request.`,
    );
    res.json(toAppointment(row!));
  }),
);

export default router;
