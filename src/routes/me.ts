import { Router } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  appointments,
  biometrics,
  dependents,
  documents,
  insuranceInfo,
  labs,
  payments,
  pharmacies,
  pharmacyPreferences,
  prescriptions,
  userSettings,
  users,
  type DependentRow,
  type DocumentRow,
  type PharmacyPreferenceRow,
  type UserSettingsRow,
} from '../db/schema';
import { env } from '../config/env';
import { HttpError } from '../lib/errors';
import { biometricsInputSchema, insertLab, labInputSchema, toBiometrics, toLab, toPrescription, upsertBiometrics } from './practice';
import { asyncHandler, param } from '../lib/http';
import { auditAccess } from '../middleware/audit';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

/**
 * Per-user records: dependents, insurance, pharmacy, settings.
 *
 * Every query is scoped to req.user.id — these are personal health details, so
 * an id in the URL is never enough on its own to reach a row.
 */

function toDependent(d: DependentRow) {
  return {
    id: d.id,
    firstName: d.firstName,
    lastName: d.lastName,
    dob: d.dob,
    relationship: d.relationship ?? undefined,
  };
}

// ── Dependents ──────────────────────────────────────────────────────────────

/** GET /me/dependents — people this user can book on behalf of. */
router.get(
  '/dependents',
  asyncHandler(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(dependents)
      .where(eq(dependents.userId, req.user!.id))
      .orderBy(asc(dependents.createdAt));
    res.json(rows.map(toDependent));
  }),
);

/** POST /me/dependents */
router.post(
  '/dependents',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        firstName: z.string().min(1),
        lastName: z.string().min(1),
        dob: z.string().min(1),
        relationship: z.string().max(60).optional(),
      })
      .parse(req.body);

    const [row] = await getDb()
      .insert(dependents)
      .values({ ...input, userId: req.user!.id })
      .returning();
    res.status(201).json(toDependent(row!));
  }),
);

/** DELETE /me/dependents/:id */
router.delete(
  '/dependents/:id',
  asyncHandler(async (req, res) => {
    const [row] = await getDb()
      .delete(dependents)
      .where(and(eq(dependents.id, param(req, 'id')), eq(dependents.userId, req.user!.id)))
      .returning();
    if (!row) throw new HttpError(404, 'Dependent not found');
    res.json({ ok: true });
  }),
);

// ── Insurance ───────────────────────────────────────────────────────────────

/** GET /me/insurance — null when the user hasn't added one. */
router.get(
  '/insurance',
  asyncHandler(async (req, res) => {
    const [row] = await getDb().select().from(insuranceInfo).where(eq(insuranceInfo.userId, req.user!.id));
    res.json(
      row
        ? { provider: row.provider, memberId: row.memberId, groupNumber: row.groupNumber ?? undefined }
        : null,
    );
  }),
);

/** PUT /me/insurance — upsert; one record per user. */
router.put(
  '/insurance',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        provider: z.string().min(1),
        memberId: z.string().min(1),
        groupNumber: z.string().optional(),
      })
      .parse(req.body);

    // PUT replaces the record, so an omitted optional field must be cleared —
    // spreading `input` alone would leave a stale groupNumber behind and make
    // it impossible to remove one.
    const values = {
      provider: input.provider,
      memberId: input.memberId,
      groupNumber: input.groupNumber ?? null,
    };
    const [row] = await getDb()
      .insert(insuranceInfo)
      .values({ ...values, userId: req.user!.id })
      .onConflictDoUpdate({
        target: insuranceInfo.userId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    res.json({ provider: row!.provider, memberId: row!.memberId, groupNumber: row!.groupNumber ?? undefined });
  }),
);

// ── Preferred pharmacy ──────────────────────────────────────────────────────

/**
 * Resolve a saved preference to its display shape. When it references a
 * directory pharmacy (Batch 3 Phase 3), the client gets that pharmacy's
 * current name/address/fax — not a stale copy — plus `pharmacyId` so the UI
 * knows it's an in-network pick rather than free text.
 */
async function resolvePharmacyPreference(pref: PharmacyPreferenceRow) {
  if (pref.pharmacyId) {
    const [pharmacy] = await getDb().select().from(pharmacies).where(eq(pharmacies.id, pref.pharmacyId));
    if (pharmacy) return { pharmacyId: pharmacy.id, name: pharmacy.name, address: pharmacy.address, fax: pharmacy.fax };
  }
  return { pharmacyId: null, name: pref.name ?? undefined, address: pref.address ?? '', fax: pref.fax ?? '' };
}

/** GET /me/pharmacy — null when the user hasn't set one. */
router.get(
  '/pharmacy',
  asyncHandler(async (req, res) => {
    const [row] = await getDb()
      .select()
      .from(pharmacyPreferences)
      .where(eq(pharmacyPreferences.userId, req.user!.id));
    res.json(row ? await resolvePharmacyPreference(row) : null);
  }),
);

/**
 * PUT /me/pharmacy — upsert; one preference per user. Accepts either shape:
 * `{ pharmacyId }` to pick a directory pharmacy (in-network), or
 * `{ name?, address, fax }` free text for one that isn't in the directory
 * (out-of-network fallback — never blocked on a pharmacy being onboarded).
 */
const pharmacyInputSchema = z.union([
  z.object({ pharmacyId: z.string().min(1) }),
  z.object({ name: z.string().optional(), address: z.string().min(1), fax: z.string().min(1) }),
]);

router.put(
  '/pharmacy',
  asyncHandler(async (req, res) => {
    const input = pharmacyInputSchema.parse(req.body);

    // Same as insurance: PUT replaces, so switching shapes clears the other.
    const values =
      'pharmacyId' in input
        ? { pharmacyId: input.pharmacyId, name: null, address: null, fax: null }
        : { pharmacyId: null, name: input.name ?? null, address: input.address, fax: input.fax };

    const [row] = await getDb()
      .insert(pharmacyPreferences)
      .values({ ...values, userId: req.user!.id })
      .onConflictDoUpdate({
        target: pharmacyPreferences.userId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    res.json(await resolvePharmacyPreference(row!));
  }),
);

// ── Government ID verification ──────────────────────────────────────────────

function govIdUrl(key: string | null): string | null {
  if (!key) return null;
  const base = env.r2.publicBaseUrl;
  return base ? `${base.replace(/\/$/, '')}/${key}` : key;
}

/** GET /me/gov-id — status of the signed-in user's own gov-ID verification. */
router.get(
  '/gov-id',
  asyncHandler(async (req, res) => {
    const [user] = await getDb().select().from(users).where(eq(users.id, req.user!.id));
    if (!user) throw new HttpError(401, 'Session expired or invalid');
    res.json({
      status: user.govIdStatus,
      fileName: user.govIdFileName ?? undefined,
      url: govIdUrl(user.govIdKey),
    });
  }),
);

/**
 * PUT /me/gov-id — submit (or resubmit after a rejection) a government-ID
 * document for review. Always resets status to 'pending' — not a booking
 * gate, so there's no reason to block a resubmit.
 */
router.put(
  '/gov-id',
  asyncHandler(async (req, res) => {
    const { key, fileName } = z.object({ key: z.string().min(1), fileName: z.string().min(1) }).parse(req.body);
    const [user] = await getDb()
      .update(users)
      .set({ govIdStatus: 'pending', govIdKey: key, govIdFileName: fileName })
      .where(eq(users.id, req.user!.id))
      .returning();
    if (!user) throw new HttpError(401, 'Session expired or invalid');
    res.json({ status: user.govIdStatus, fileName: user.govIdFileName ?? undefined, url: govIdUrl(user.govIdKey) });
  }),
);

// ── Documents & Certifications ──────────────────────────────────────────────

/** Build the client's `url` from the stored R2 key + public base, when set. */
function documentUrl(storageKey: string | null): string | null {
  if (!storageKey) return null;
  const base = env.r2.publicBaseUrl;
  return base ? `${base.replace(/\/$/, '')}/${storageKey}` : storageKey;
}

function toDocument(d: DocumentRow) {
  return {
    id: d.id,
    name: d.name,
    category: d.category,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    url: documentUrl(d.storageKey),
    uploadedAt: d.uploadedAt,
    createdAt: d.createdAt.toISOString(),
  };
}

/** GET /me/documents — the user's uploaded credentials, newest first. */
router.get(
  '/documents',
  auditAccess('document'),
  asyncHandler(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(documents)
      .where(eq(documents.userId, req.user!.id))
      .orderBy(desc(documents.createdAt));
    res.json(rows.map(toDocument));
  }),
);

/**
 * POST /me/documents — record a document already uploaded to R2 via
 * /uploads/presign. The client sends the returned object key plus metadata;
 * the backend never sees the bytes.
 */
router.post(
  '/documents',
  auditAccess('document'),
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().min(1).max(120),
        category: z.enum(['license', 'certification', 'government-id', 'insurance', 'other']),
        fileName: z.string().min(1).max(200),
        mimeType: z.string().min(1).max(120),
        sizeBytes: z.number().int().nonnegative(),
        key: z.string().min(1).optional(),
      })
      .parse(req.body);

    const uploadedAt = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const [row] = await getDb()
      .insert(documents)
      .values({
        userId: req.user!.id,
        name: input.name,
        category: input.category,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageKey: input.key ?? null,
        uploadedAt,
      })
      .returning();
    res.status(201).json(toDocument(row!));
  }),
);

/** DELETE /me/documents/:id — scoped to the owner. */
router.delete(
  '/documents/:id',
  auditAccess('document'),
  asyncHandler(async (req, res) => {
    const [row] = await getDb()
      .delete(documents)
      .where(and(eq(documents.id, param(req, 'id')), eq(documents.userId, req.user!.id)))
      .returning();
    if (!row) throw new HttpError(404, 'Document not found');
    res.json({ ok: true });
  }),
);

// ── Biometrics (vitals, patient self-view/report) ───────────────────────────

/** GET /me/biometrics — the signed-in patient's own current vitals, or null. */
router.get(
  '/biometrics',
  asyncHandler(async (req, res) => {
    const [row] = await getDb().select().from(biometrics).where(eq(biometrics.patientId, req.user!.id));
    res.json(toBiometrics(row));
  }),
);

/** PUT /me/biometrics — self-report vitals (e.g. from a home cuff/scale). */
router.put(
  '/biometrics',
  asyncHandler(async (req, res) => {
    const input = biometricsInputSchema.parse(req.body);
    const row = await upsertBiometrics(req.user!.id, input);
    res.status(201).json(toBiometrics(row));
  }),
);

// ── Prescriptions (patient self-view) ───────────────────────────────────────

/**
 * GET /me/prescriptions — the signed-in patient's own medication record
 * (current + historical), read-only. Scoped to req.user.id; only a prescriber
 * can add to it (via /practice/patients/:id/prescriptions).
 */
router.get(
  '/prescriptions',
  auditAccess('prescription'),
  asyncHandler(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(prescriptions)
      .where(eq(prescriptions.patientId, req.user!.id))
      .orderBy(desc(prescriptions.createdAt));
    res.json(rows.map(toPrescription));
  }),
);

// ── Labs (patient self) ─────────────────────────────────────────────────────

/** GET /me/labs — the signed-in patient's own lab results. */
router.get(
  '/labs',
  auditAccess('lab'),
  asyncHandler(async (req, res) => {
    const rows = await getDb()
      .select()
      .from(labs)
      .where(eq(labs.patientId, req.user!.id))
      .orderBy(desc(labs.createdAt));
    res.json(rows.map(toLab));
  }),
);

/** POST /me/labs — patient logs their own result (e.g. an outside test). */
router.post(
  '/labs',
  auditAccess('lab'),
  asyncHandler(async (req, res) => {
    const input = labInputSchema.parse(req.body);
    const row = await insertLab(req.user!.id, input);
    res.status(201).json(toLab(row));
  }),
);

/** DELETE /me/labs/:id — scoped to the owner. */
router.delete(
  '/labs/:id',
  auditAccess('lab'),
  asyncHandler(async (req, res) => {
    const [row] = await getDb()
      .delete(labs)
      .where(and(eq(labs.id, param(req, 'id')), eq(labs.patientId, req.user!.id)))
      .returning();
    if (!row) throw new HttpError(404, 'Lab result not found');
    res.json({ ok: true });
  }),
);

// ── Settings ────────────────────────────────────────────────────────────────

function toSettings(s: UserSettingsRow) {
  return {
    pushNotifications: s.pushNotifications,
    emailNotifications: s.emailNotifications,
    smsNotifications: s.smsNotifications,
    darkMode: s.darkMode,
    locationAccess: s.locationAccess,
  };
}

/** The defaults a user gets before they've ever saved settings. */
const DEFAULT_SETTINGS = {
  pushNotifications: true,
  emailNotifications: true,
  smsNotifications: false,
  darkMode: false,
  locationAccess: true,
};

/** GET /me/settings — defaults (not 404) when no row exists yet. */
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const [row] = await getDb().select().from(userSettings).where(eq(userSettings.userId, req.user!.id));
    res.json(row ? toSettings(row) : DEFAULT_SETTINGS);
  }),
);

/**
 * PATCH /me/settings — partial update, upserting on first save.
 *
 * These flags are advisory for future push/email fan-out. Transactional
 * messages (OTP codes, password resets) are always delivered regardless —
 * they're not marketing, and silencing them would lock people out.
 */
router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        pushNotifications: z.boolean().optional(),
        emailNotifications: z.boolean().optional(),
        smsNotifications: z.boolean().optional(),
        darkMode: z.boolean().optional(),
        locationAccess: z.boolean().optional(),
      })
      .parse(req.body);
    if (!Object.keys(input).length) throw new HttpError(400, 'Nothing to update.');

    const [row] = await getDb()
      .insert(userSettings)
      .values({ ...DEFAULT_SETTINGS, ...input, userId: req.user!.id })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { ...input, updatedAt: new Date() },
      })
      .returning();
    res.json(toSettings(row!));
  }),
);

// ── Payment history ─────────────────────────────────────────────────────────

/**
 * GET /me/payments — every settled payment this patient made, newest first.
 *
 * `amount`/`currency` are what was actually charged at the gateway (USD for
 * PayPal, NGN for Flutterwave) — do not sum these across rows, they mix
 * currencies. The breakdown fields (consultationFee/serviceCharge/vat/
 * discount) are always canonical NGN regardless of gateway, so summable
 * client-side for a "total spent" figure (same reasoning as
 * routes/admin.ts's revenue stat).
 */
router.get(
  '/payments',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const rows = await db
      .select({ payment: payments, appt: appointments })
      .from(payments)
      .innerJoin(appointments, eq(payments.appointmentId, appointments.id))
      .where(and(eq(appointments.patientId, req.user!.id), eq(payments.status, 'succeeded')))
      .orderBy(desc(payments.createdAt));

    res.json(
      rows.map(({ payment, appt }) => ({
        id: payment.id,
        doctorName: appt.doctorName,
        specialty: appt.specialty,
        visitType: appt.type,
        date: appt.date,
        time: appt.time,
        provider: payment.provider,
        amount: payment.amount,
        currency: payment.currency,
        consultationFee: payment.consultationFee ?? undefined,
        serviceCharge: payment.serviceCharge ?? undefined,
        vat: payment.vat ?? undefined,
        discount: payment.discount,
        promoCode: payment.promoCode ?? undefined,
        createdAt: payment.createdAt.toISOString(),
      })),
    );
  }),
);

export default router;
