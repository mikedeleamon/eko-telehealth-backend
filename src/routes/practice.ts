import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  agendaItems,
  appointments,
  biometrics,
  doctors,
  earningsLedger,
  labs,
  medicalNotes,
  payments,
  prescriptions,
  rosterPatients,
  users,
  type BiometricsRow,
  type EarningsLedgerRow,
  type LabRow,
  type MedicalNoteRow,
  type NoteAmendment,
  type PrescriptionRow,
} from '../db/schema';
import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { formatClockTime, formatJoined, formatNaira } from '../lib/format';
import { auditAccess } from '../middleware/audit';
import { requireAuth, requireAccountType } from '../middleware/auth';
import { getDoctorAvailability, setDoctorAvailability } from '../services/availability';
import { notify } from '../services/notify';
import { toAppointment } from './appointments';
import { capabilitiesFor } from '../lib/providerCapabilities';

const router = Router();
// 'Provider' covers Nurse/Therapist accounts too (Batch 3 Phase 2) — capability
// (can this specific provider prescribe/order labs) is a narrower, per-route
// check below, not an account-type gate.
router.use(requireAuth, requireAccountType('Doctor', 'Provider', 'Admin'));

/** Resolve the doctor profile linked to the signed-in doctor user (if any). */
async function doctorIdFor(userId: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db.select().from(doctors).where(eq(doctors.userId, userId));
  return row?.id ?? null;
}

/**
 * Resolve a roster-patient id (what doctor-facing screens pass in the URL) to
 * the real account id doctor-authored records should be stored/queried
 * against — so a patient with an app account sees them in their own self-view
 * (/me/prescriptions, /me/labs). Unlinked roster entries (walk-ins, demo-only
 * names) resolve to themselves, exactly as before this link existed.
 *
 * Self-healing: when not yet linked, tries a one-shot match — a patient user
 * who has a real appointment with this doctor AND whose name matches the
 * roster entry exactly (case-insensitive). The appointment is the proof the
 * two rows are the same person; ambiguous or no match is left unlinked rather
 * than guessing wrong. Once linked, the match is persisted and skipped next
 * time.
 */
async function resolvePatientId(rosterId: string): Promise<string> {
  const db = getDb();
  const [roster] = await db.select().from(rosterPatients).where(eq(rosterPatients.id, rosterId));
  if (!roster) return rosterId; // not a roster row — use as-is (defensive, shouldn't happen)
  if (roster.userId) return roster.userId;

  const patientIds = [
    ...new Set(
      (
        await db
          .select({ patientId: appointments.patientId })
          .from(appointments)
          .where(eq(appointments.doctorId, roster.doctorId))
      ).map((a) => a.patientId),
    ),
  ];
  if (!patientIds.length) return rosterId;

  const candidates = await db.select().from(users).where(inArray(users.id, patientIds));
  const target = roster.name.trim().toLowerCase();
  const matches = candidates.filter((u) => `${u.firstName} ${u.lastName}`.trim().toLowerCase() === target);
  if (matches.length !== 1) return rosterId; // no match or ambiguous — stay unlinked

  await db.update(rosterPatients).set({ userId: matches[0].id }).where(eq(rosterPatients.id, rosterId));
  return matches[0].id;
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

// ── Biometrics (vitals) ─────────────────────────────────────────────────────

export function toBiometrics(b: BiometricsRow | undefined) {
  if (!b) return null;
  return {
    bloodPressure: b.bloodPressure ?? undefined,
    heartRate: b.heartRate ?? undefined,
    temperature: b.temperature ?? undefined,
    weight: b.weight ?? undefined,
    height: b.height ?? undefined,
    bmi: b.bmi ?? undefined,
    bloodType: b.bloodType ?? undefined,
    recordedAt: b.recordedAt,
  };
}

export const biometricsInputSchema = z.object({
  bloodPressure: z.string().max(20).optional(),
  heartRate: z.string().max(20).optional(),
  temperature: z.string().max(20).optional(),
  weight: z.string().max(20).optional(),
  height: z.string().max(20).optional(),
  bmi: z.string().max(20).optional(),
  bloodType: z.string().max(10).optional(),
});

/** Upsert the one vitals row for `patientId` — shared by both the doctor and patient-self-service routes below. */
export async function upsertBiometrics(patientId: string, input: z.infer<typeof biometricsInputSchema>): Promise<BiometricsRow> {
  const values = {
    patientId,
    bloodPressure: input.bloodPressure ?? null,
    heartRate: input.heartRate ?? null,
    temperature: input.temperature ?? null,
    weight: input.weight ?? null,
    height: input.height ?? null,
    bmi: input.bmi ?? null,
    bloodType: input.bloodType ?? null,
    recordedAt: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };
  const [row] = await getDb()
    .insert(biometrics)
    .values(values)
    .onConflictDoUpdate({ target: biometrics.patientId, set: { ...values, updatedAt: new Date() } })
    .returning();
  return row!;
}

/** GET /practice/patients/:patientId/biometrics — a roster patient's current vitals, or null if none recorded. */
router.get(
  '/patients/:patientId/biometrics',
  asyncHandler(async (req, res) => {
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const [row] = await getDb().select().from(biometrics).where(eq(biometrics.patientId, patientId));
    res.json(toBiometrics(row));
  }),
);

/** PUT /practice/patients/:patientId/biometrics — record/update a roster patient's vitals. */
router.put(
  '/patients/:patientId/biometrics',
  asyncHandler(async (req, res) => {
    const input = biometricsInputSchema.parse(req.body);
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const row = await upsertBiometrics(patientId, input);
    res.status(201).json(toBiometrics(row));
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

/** Shape returned/accepted for a single availability block. */
function toAvailabilityBlock(b: { id: string; weekday: number; startMinute: number; endMinute: number; slotMinutes: number }) {
  return { id: b.id, weekday: b.weekday, startMinute: b.startMinute, endMinute: b.endMinute, slotMinutes: b.slotMinutes };
}

/** GET /practice/availability — the signed-in doctor's recurring weekly working hours. */
router.get(
  '/availability',
  asyncHandler(async (req, res) => {
    const docId = await doctorIdFor(req.user!.id);
    if (!docId) {
      res.json([]); // no linked profile yet
      return;
    }
    const blocks = await getDoctorAvailability(docId);
    res.json(blocks.map(toAvailabilityBlock));
  }),
);

const availabilityBlockInputSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: z.number().int().min(0).max(1439),
    endMinute: z.number().int().min(1).max(1440),
    slotMinutes: z.number().int().positive().default(60),
  })
  .refine((b) => b.endMinute > b.startMinute, { message: 'End time must be after start time.' });

/**
 * PUT /practice/availability — replace the signed-in doctor's whole weekly
 * schedule in one call, matching the "set my hours" screen's single Save
 * button rather than editing one block at a time.
 */
router.put(
  '/availability',
  asyncHandler(async (req, res) => {
    const docId = await doctorIdFor(req.user!.id);
    if (!docId) throw new HttpError(403, 'No doctor profile is linked to this account yet.');
    const { blocks } = z.object({ blocks: z.array(availabilityBlockInputSchema) }).parse(req.body);
    const saved = await setDoctorAvailability(docId, blocks);
    res.json(saved.map(toAvailabilityBlock));
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

/**
 * POST /practice/appointments/:id/no-show — doctor marks the patient as not
 * attending. Manual only this batch — no automatic detection, since that
 * needs a scheduler that doesn't exist yet. Guarded to only fire once the
 * visit's start time has actually passed, so a doctor can't jump the gun.
 */
router.post(
  '/appointments/:id/no-show',
  asyncHandler(async (req, res) => {
    const existing = await ownedAppointment(req.user!.id, param(req, 'id'));
    if (!['upcoming', 'checked_in'].includes(existing.status)) {
      throw new HttpError(409, `This appointment can't be marked no-show (it is ${existing.status}).`);
    }
    if (!existing.startAt || existing.startAt > new Date()) {
      throw new HttpError(409, "This appointment hasn't started yet.");
    }

    const db = getDb();
    const [row] = await db
      .update(appointments)
      .set({ status: 'no_show' })
      .where(eq(appointments.id, existing.id))
      .returning();

    await notify(
      existing.patientId,
      'Marked as No-Show',
      `You were marked as not attending your ${existing.date} ${existing.time} appointment with ${existing.doctorName}.`,
    );
    res.json(toAppointment(row!));
  }),
);

/**
 * GET /practice/appointments/:id/breakdown — a doctor's take-home detail for
 * a paid visit (what AppointmentDetailsScreen shows instead of the raw fee).
 * 404s until a payment has actually settled — there's nothing to break down
 * before that, and the breakdown belongs to the settled payment, not the
 * appointment's display fee.
 */
router.get(
  '/appointments/:id/breakdown',
  asyncHandler(async (req, res) => {
    const existing = await ownedAppointment(req.user!.id, param(req, 'id'));
    const db = getDb();
    const [payment] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.appointmentId, existing.id), eq(payments.status, 'succeeded')))
      .orderBy(desc(payments.createdAt))
      .limit(1);
    if (!payment || payment.consultationFee == null) {
      throw new HttpError(404, 'No settled payment for this appointment yet.');
    }
    res.json({
      consultationFee: payment.consultationFee,
      serviceCharge: payment.serviceCharge ?? 0,
      vat: payment.vat ?? 0,
      discount: payment.discount,
      providerCommission: payment.providerCommission ?? 0,
      providerPayout: payment.providerPayout ?? 0,
    });
  }),
);

// ── Medical notes (SOAP records) ────────────────────────────────────────────

function toNote(n: MedicalNoteRow) {
  return {
    id: n.id,
    patientId: n.patientId,
    appointmentId: n.appointmentId,
    date: n.date,
    visitType: n.visitType ?? undefined,
    doctorId: n.doctorId ?? '',
    doctorName: n.doctorName,
    doctorSpecialty: n.doctorSpecialty,
    reason: n.reason,
    subjective: n.subjective,
    objective: n.objective,
    assessment: n.assessment,
    primaryDiagnosis: n.primaryDiagnosis ?? undefined,
    secondaryDiagnoses: n.secondaryDiagnoses ?? [],
    plan: n.plan,
    status: n.status,
    amendments: n.amendments ?? [],
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt?.toISOString(),
  };
}

const noteInputSchema = z.object({
  appointmentId: z.string().min(1),
  date: z.string().min(1),
  visitType: z.string().optional(),
  reason: z.string().min(1),
  subjective: z.string().default(''),
  objective: z.string().default(''),
  assessment: z.string().default(''),
  primaryDiagnosis: z.string().optional(),
  secondaryDiagnoses: z.array(z.string()).optional(),
  plan: z.string().default(''),
  status: z.enum(['draft', 'final']).default('final'),
});

/**
 * GET /practice/patients/:patientId/notes — every note for the patient, shared
 * across treating doctors. Drafts are private: only their author sees them.
 */
router.get(
  '/patients/:patientId/notes',
  auditAccess('medical_note'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const myDocId = await doctorIdFor(req.user!.id);
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const rows = await db
      .select()
      .from(medicalNotes)
      .where(eq(medicalNotes.patientId, patientId))
      .orderBy(desc(medicalNotes.createdAt));
    const visible = rows.filter((n) => n.status === 'final' || (myDocId && n.doctorId === myDocId));
    res.json(visible.map(toNote));
  }),
);

/**
 * POST /practice/patients/:patientId/notes — create a record (draft or final).
 * Author identity is stamped from the signed-in doctor, never sent by the client.
 */
router.post(
  '/patients/:patientId/notes',
  auditAccess('medical_note'),
  asyncHandler(async (req, res) => {
    const input = noteInputSchema.parse(req.body);
    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    const [doc] = docId ? await db.select().from(doctors).where(eq(doctors.id, docId)) : [];
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const [row] = await db
      .insert(medicalNotes)
      .values({
        patientId,
        appointmentId: input.appointmentId,
        date: input.date,
        visitType: input.visitType ?? null,
        doctorId: docId,
        doctorName: doc?.name ?? req.user!.email,
        doctorSpecialty: doc?.specialty ?? '',
        reason: input.reason,
        subjective: input.subjective,
        objective: input.objective,
        assessment: input.assessment,
        primaryDiagnosis: input.primaryDiagnosis ?? null,
        secondaryDiagnoses: input.secondaryDiagnoses ?? [],
        plan: input.plan,
        status: input.status,
      })
      .returning();
    res.status(201).json(toNote(row!));
  }),
);

/**
 * PATCH /practice/notes/:noteId — update a DRAFT (save-draft-again or finalize
 * by sending status:'final'). Only the author can edit, and only while it's a
 * draft: a finalized record is immutable (amend it instead).
 */
router.patch(
  '/notes/:noteId',
  auditAccess('medical_note'),
  asyncHandler(async (req, res) => {
    const input = noteInputSchema.parse(req.body);
    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    const [existing] = await db.select().from(medicalNotes).where(eq(medicalNotes.id, param(req, 'noteId')));
    if (!existing) throw new HttpError(404, 'Record not found');
    if (!docId || existing.doctorId !== docId) throw new HttpError(404, 'Record not found');
    if (existing.status === 'final') throw new HttpError(409, 'A finalized record cannot be edited. Add an amendment instead.');

    const [row] = await db
      .update(medicalNotes)
      .set({
        appointmentId: input.appointmentId,
        date: input.date,
        visitType: input.visitType ?? null,
        reason: input.reason,
        subjective: input.subjective,
        objective: input.objective,
        assessment: input.assessment,
        primaryDiagnosis: input.primaryDiagnosis ?? null,
        secondaryDiagnoses: input.secondaryDiagnoses ?? [],
        plan: input.plan,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(medicalNotes.id, existing.id))
      .returning();
    res.json(toNote(row!));
  }),
);

/**
 * POST /practice/notes/:noteId/amendments — append an amendment to a locked
 * record. The SOAP body is never touched. Author is stamped server-side.
 */
router.post(
  '/notes/:noteId/amendments',
  auditAccess('medical_note'),
  asyncHandler(async (req, res) => {
    const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    const db = getDb();
    const [existing] = await db.select().from(medicalNotes).where(eq(medicalNotes.id, param(req, 'noteId')));
    if (!existing) throw new HttpError(404, 'Record not found');

    const [author] = await db.select().from(users).where(eq(users.id, req.user!.id));
    const amendment: NoteAmendment = {
      id: randomUUID(),
      text,
      authorId: req.user!.id,
      authorName: author ? `${author.firstName} ${author.lastName}` : req.user!.email,
      createdAt: new Date().toISOString(),
    };
    const [row] = await db
      .update(medicalNotes)
      .set({ amendments: [...(existing.amendments ?? []), amendment], updatedAt: new Date() })
      .where(eq(medicalNotes.id, existing.id))
      .returning();
    res.json(toNote(row!));
  }),
);

// ── Prescriptions ───────────────────────────────────────────────────────────

/** Map a prescription row to the client shape. */
export function toPrescription(p: PrescriptionRow) {
  return {
    id: p.id,
    patientId: p.patientId,
    drug: p.drug,
    strength: p.strength,
    form: p.form,
    route: p.route,
    frequency: p.frequency,
    duration: p.duration,
    quantity: p.quantity,
    refills: p.refills,
    instructions: p.instructions ?? undefined,
    status: p.status,
    doctorId: p.doctorId ?? '',
    doctorName: p.doctorName,
    datePrescribed: p.datePrescribed,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * GET /practice/patients/:patientId/prescriptions — the patient's full
 * medication record (current + historical), shared across treating doctors.
 */
router.get(
  '/patients/:patientId/prescriptions',
  auditAccess('prescription'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const rows = await db
      .select()
      .from(prescriptions)
      .where(eq(prescriptions.patientId, patientId))
      .orderBy(desc(prescriptions.createdAt));
    res.json(rows.map(toPrescription));
  }),
);

/**
 * POST /practice/patients/:patientId/prescriptions — write a new prescription
 * (becomes a current medication). The prescriber is stamped server-side from
 * the signed-in doctor, never sent by the client.
 */
router.post(
  '/patients/:patientId/prescriptions',
  auditAccess('prescription'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        drug: z.string().min(1),
        strength: z.string().min(1),
        form: z.string().min(1),
        route: z.string().min(1),
        frequency: z.string().min(1),
        duration: z.string().min(1),
        quantity: z.string().min(1),
        refills: z.string().min(1),
        instructions: z.string().max(500).optional(),
      })
      .parse(req.body);

    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    const [doc] = docId ? await db.select().from(doctors).where(eq(doctors.id, docId)) : [];
    if (doc && !capabilitiesFor(doc.providerType).canPrescribe) {
      throw new HttpError(403, `${doc.providerType}s aren't able to write prescriptions.`);
    }
    const doctorName = doc?.name ?? `${req.user!.email}`;
    const datePrescribed = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const patientId = await resolvePatientId(param(req, 'patientId'));

    const [row] = await db
      .insert(prescriptions)
      .values({
        patientId,
        ...input,
        instructions: input.instructions ?? null,
        status: 'active',
        doctorId: docId,
        doctorName,
        datePrescribed,
      })
      .returning();
    res.status(201).json(toPrescription(row!));
  }),
);

// ── Labs ────────────────────────────────────────────────────────────────────

/** Build the client `attachmentUrl` from the stored R2 key + public base. */
function labAttachmentUrl(key: string | null): string | null {
  if (!key) return null;
  const base = env.r2.publicBaseUrl;
  return base ? `${base.replace(/\/$/, '')}/${key}` : key;
}

export function toLab(l: LabRow) {
  return {
    id: l.id,
    patientId: l.patientId,
    testName: l.testName,
    loincCode: l.loincCode ?? undefined,
    specimen: l.specimen,
    value: l.value,
    unit: l.unit ?? undefined,
    referenceRange: l.referenceRange ?? undefined,
    flag: l.flag,
    status: l.status,
    orderedBy: l.orderedBy ?? undefined,
    performingLab: l.performingLab ?? undefined,
    collectedDate: l.collectedDate,
    resultedDate: l.resultedDate ?? undefined,
    notes: l.notes ?? undefined,
    attachmentUrl: labAttachmentUrl(l.attachmentKey),
    attachmentName: l.attachmentName ?? undefined,
    createdAt: l.createdAt.toISOString(),
  };
}

/** Shared body validation for adding a lab (patient self + doctor surfaces). */
export const labInputSchema = z.object({
  testName: z.string().min(1).max(160),
  loincCode: z.string().max(20).optional(),
  specimen: z.string().min(1).max(80),
  value: z.string().min(1).max(80),
  unit: z.string().max(40).optional(),
  referenceRange: z.string().max(80).optional(),
  flag: z.enum(['normal', 'low', 'high', 'critical', 'abnormal']),
  status: z.enum(['ordered', 'collected', 'resulted']),
  orderedBy: z.string().max(120).optional(),
  performingLab: z.string().max(120).optional(),
  collectedDate: z.string().min(1).max(40),
  resultedDate: z.string().max(40).optional(),
  notes: z.string().max(1000).optional(),
  attachmentKey: z.string().max(300).optional(),
  attachmentName: z.string().max(200).optional(),
});

/** Insert a lab for the given patient id (roster id or user id). */
export async function insertLab(patientId: string, input: z.infer<typeof labInputSchema>) {
  const [row] = await getDb()
    .insert(labs)
    .values({
      patientId,
      testName: input.testName,
      loincCode: input.loincCode ?? null,
      specimen: input.specimen,
      value: input.value,
      unit: input.unit ?? null,
      referenceRange: input.referenceRange ?? null,
      flag: input.flag,
      status: input.status,
      orderedBy: input.orderedBy ?? null,
      performingLab: input.performingLab ?? null,
      collectedDate: input.collectedDate,
      resultedDate: input.resultedDate ?? null,
      notes: input.notes ?? null,
      attachmentKey: input.attachmentKey ?? null,
      attachmentName: input.attachmentName ?? null,
    })
    .returning();
  return row!;
}

/** GET /practice/patients/:patientId/labs — a patient's lab results. */
router.get(
  '/patients/:patientId/labs',
  auditAccess('lab'),
  asyncHandler(async (req, res) => {
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const rows = await getDb()
      .select()
      .from(labs)
      .where(eq(labs.patientId, patientId))
      .orderBy(desc(labs.createdAt));
    res.json(rows.map(toLab));
  }),
);

/** POST /practice/patients/:patientId/labs — add a lab result for the patient. */
router.post(
  '/patients/:patientId/labs',
  auditAccess('lab'),
  asyncHandler(async (req, res) => {
    const input = labInputSchema.parse(req.body);
    const db = getDb();
    const docId = await doctorIdFor(req.user!.id);
    const [doc] = docId ? await db.select().from(doctors).where(eq(doctors.id, docId)) : [];
    if (doc && !capabilitiesFor(doc.providerType).canOrderLabs) {
      throw new HttpError(403, `${doc.providerType}s aren't able to order labs.`);
    }
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const row = await insertLab(patientId, input);
    res.status(201).json(toLab(row));
  }),
);

/** DELETE /practice/patients/:patientId/labs/:id */
router.delete(
  '/patients/:patientId/labs/:id',
  auditAccess('lab'),
  asyncHandler(async (req, res) => {
    const patientId = await resolvePatientId(param(req, 'patientId'));
    const [row] = await getDb()
      .delete(labs)
      .where(and(eq(labs.id, param(req, 'id')), eq(labs.patientId, patientId)))
      .returning();
    if (!row) throw new HttpError(404, 'Lab result not found');
    res.json({ ok: true });
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

// ── Earnings & payouts ──────────────────────────────────────────────────────

/** Minimum a doctor can withdraw at once — mirrors the app's mock (CashOutScreen). */
const MIN_CASHOUT = 1000;

function toEarningItem(r: EarningsLedgerRow) {
  return { id: r.id, kind: r.kind, title: r.title, date: r.date, time: r.time, amount: r.amount, status: r.status };
}

/**
 * Derive wallet totals from the ledger. Mirrors the app's mock
 * (summarizeEarnings in mockApi.ts) with one deliberate difference:
 * `thisMonth` is filtered to the current calendar month here, honoring the
 * DoctorEarnings.thisMonth contract ("Total earned in the current calendar
 * month") — the mock's version sums every settled earning regardless of
 * date, a demo-data shortcut that happens to hold because the seed data is
 * always recent.
 */
function summarizeEarnings(rows: EarningsLedgerRow[]) {
  const now = new Date();
  let balance = 0;
  let pending = 0;
  let thisMonth = 0;
  for (const item of rows) {
    if (item.kind === 'earning') {
      if (item.status === 'settled') {
        balance += item.amount;
        if (item.createdAt.getFullYear() === now.getFullYear() && item.createdAt.getMonth() === now.getMonth()) {
          thisMonth += item.amount;
        }
      }
    } else {
      balance -= item.amount;
      if (item.status === 'pending') pending += item.amount;
    }
  }
  return { balance, thisMonth, pending, currency: 'NGN', items: rows.map(toEarningItem) };
}

/** GET /practice/earnings — the doctor's wallet: balance + earnings ledger. */
router.get(
  '/earnings',
  asyncHandler(async (req, res) => {
    const docId = await doctorIdFor(req.user!.id);
    if (!docId) throw new HttpError(403, 'No doctor profile is linked to this account yet.');
    const db = getDb();
    const rows = await db.select().from(earningsLedger).where(eq(earningsLedger.doctorId, docId)).orderBy(desc(earningsLedger.createdAt));
    res.json(summarizeEarnings(rows));
  }),
);

/**
 * POST /practice/payouts — withdraw `amount` from the wallet balance.
 *
 * The destination is meant to be the doctor's saved payment method, resolved
 * server-side (never sent by the client) — /me/payment-method isn't wired to
 * this yet, so the withdrawal is simply recorded 'pending', as if queued for
 * an operator/payment-rail to settle, matching the mock's cash-out behavior.
 */
router.post(
  '/payouts',
  asyncHandler(async (req, res) => {
    const { amount } = z.object({ amount: z.number().positive() }).parse(req.body);
    const docId = await doctorIdFor(req.user!.id);
    if (!docId) throw new HttpError(403, 'No doctor profile is linked to this account yet.');
    if (amount < MIN_CASHOUT) throw new HttpError(400, `Minimum withdrawal is ${formatNaira(MIN_CASHOUT)}.`);

    const db = getDb();
    const rows = await db.select().from(earningsLedger).where(eq(earningsLedger.doctorId, docId));
    const { balance } = summarizeEarnings(rows);
    if (amount > balance) throw new HttpError(409, 'Withdrawal exceeds available balance.');

    const now = new Date();
    await db.insert(earningsLedger).values({
      doctorId: docId,
      kind: 'withdrawal',
      title: 'Withdrawal',
      date: formatJoined(now),
      time: formatClockTime(now),
      amount,
      status: 'pending',
    });

    const updated = await db
      .select()
      .from(earningsLedger)
      .where(eq(earningsLedger.doctorId, docId))
      .orderBy(desc(earningsLedger.createdAt));
    res.status(201).json(summarizeEarnings(updated));
  }),
);

export default router;
