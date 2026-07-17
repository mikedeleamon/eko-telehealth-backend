import { Router } from 'express';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import {
  dependents,
  insuranceInfo,
  pharmacyPreferences,
  userSettings,
  type DependentRow,
  type UserSettingsRow,
} from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
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

/** GET /me/pharmacy — null when the user hasn't set one. */
router.get(
  '/pharmacy',
  asyncHandler(async (req, res) => {
    const [row] = await getDb()
      .select()
      .from(pharmacyPreferences)
      .where(eq(pharmacyPreferences.userId, req.user!.id));
    res.json(row ? { name: row.name ?? undefined, address: row.address, fax: row.fax } : null);
  }),
);

/** PUT /me/pharmacy — upsert; one preference per user. */
router.put(
  '/pharmacy',
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        name: z.string().optional(),
        address: z.string().min(1),
        fax: z.string().min(1),
      })
      .parse(req.body);

    // Same as insurance: PUT replaces, so an omitted `name` clears it.
    const values = { name: input.name ?? null, address: input.address, fax: input.fax };
    const [row] = await getDb()
      .insert(pharmacyPreferences)
      .values({ ...values, userId: req.user!.id })
      .onConflictDoUpdate({
        target: pharmacyPreferences.userId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    res.json({ name: row!.name ?? undefined, address: row!.address, fax: row!.fax });
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

export default router;
