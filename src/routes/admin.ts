import { Router } from 'express';
import { count, desc, eq, gte, inArray, sum } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appointments, complaints, contentBlocks, currencies, doctors, payments, pharmacies, platformSettings, promoCodes, promoRedemptions, providerApplications, reviews, users } from '../db/schema';
import { env } from '../config/env';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { formatJoined, formatNaira } from '../lib/format';
import { requireAuth, requireAccountType } from '../middleware/auth';
import { APPOINTMENT_PROVIDER_TYPES } from '../lib/providerCapabilities';
import { notify } from '../services/notify';
import { getPlatformSettings } from '../services/platformSettings';

const router = Router();
// NOTE: the admin site still needs a login screen (integration guide, Step 5).
// Until then, sign in via POST /auth/login with the seeded Admin account to get
// a token; this guard already enforces the Admin account type on every admin route.
router.use(requireAuth, requireAccountType('Admin'));

/** GET /admin/stats — dashboard counters. */
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [[patients], [providers], [weekAppts], [revenueAgg], [pendingVer], [pendingRev], [pendingComp]] = await Promise.all([
      db.select({ value: count() }).from(users).where(eq(users.accountType, 'Patient')),
      db.select({ value: count() }).from(doctors),
      db.select({ value: count() }).from(appointments).where(gte(appointments.createdAt, weekAgo)),
      // Sum the canonical-NGN breakdown columns (lib/pricing.ts), not `amount`
      // — amount is what was charged at the gateway, which is USD (not NGN)
      // for PayPal, so summing it directly would mix currencies. The
      // breakdown is always NGN regardless of gateway, so no currency filter
      // is needed here (the old query silently dropped every PayPal payment).
      db
        .select({
          serviceCharge: sum(payments.serviceCharge),
          commission: sum(payments.providerCommission),
          discount: sum(payments.discount),
          vat: sum(payments.vat),
        })
        .from(payments)
        .where(eq(payments.status, 'succeeded')),
      db.select({ value: count() }).from(providerApplications).where(eq(providerApplications.status, 'pending')),
      db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
      db.select({ value: count() }).from(complaints).where(eq(complaints.status, 'pending')),
    ]);

    // Platform revenue = service charge + provider commission − discount.
    // VAT is deliberately excluded: it's patient-borne and collected on the
    // platform's behalf, but it's a liability owed to tax authorities, not
    // platform income — reported separately as vatCollected.
    const platformRevenue =
      Number(revenueAgg?.serviceCharge ?? 0) + Number(revenueAgg?.commission ?? 0) - Number(revenueAgg?.discount ?? 0);
    const vatCollected = Number(revenueAgg?.vat ?? 0);

    res.json({
      totalPatients: patients?.value ?? 0,
      activeProviders: providers?.value ?? 0,
      appointmentsThisWeek: weekAppts?.value ?? 0,
      revenueThisMonth: formatNaira(platformRevenue),
      vatCollected: formatNaira(vatCollected),
      pendingVerifications: pendingVer?.value ?? 0,
      pendingReviews: pendingRev?.value ?? 0,
      pendingComplaints: pendingComp?.value ?? 0,
    });
  }),
);

/** GET /admin/settings — the platform's fee-schedule rates. */
router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json(await getPlatformSettings());
  }),
);

const settingsSchema = z.object({
  serviceChargePct: z.number().min(0).max(1),
  commissionPct: z.number().min(0).max(1),
  vatPct: z.number().min(0).max(1),
});

/**
 * PATCH /admin/settings — update the fee-schedule rates.
 *
 * All three fields are required (not a partial patch) so a save always
 * reflects a complete, intentional rate schedule rather than a half-updated
 * one. Rates apply going forward only — payments already checked out keep
 * the breakdown persisted on them at intent time (routes/payments.ts).
 */
router.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const rates = settingsSchema.parse(req.body);
    await getPlatformSettings(); // ensures the single row exists
    const db = getDb();
    const [row] = await db.select().from(platformSettings).limit(1);
    const [updated] = await db
      .update(platformSettings)
      .set({ ...rates, updatedAt: new Date() })
      .where(eq(platformSettings.id, row!.id))
      .returning();
    res.json({ serviceChargePct: updated!.serviceChargePct, commissionPct: updated!.commissionPct, vatPct: updated!.vatPct });
  }),
);

/** GET /admin/promos — all promo codes, with live (settled-only) redemption counts. */
router.get(
  '/promos',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const [rows, counts] = await Promise.all([
      db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt)),
      db.select({ promoId: promoRedemptions.promoId, value: count() }).from(promoRedemptions).groupBy(promoRedemptions.promoId),
    ]);
    const countByPromo = new Map(counts.map((c) => [c.promoId, Number(c.value)]));
    res.json(
      rows.map((p) => ({
        id: p.id,
        code: p.code,
        kind: p.kind,
        value: p.value,
        minSpend: p.minSpend,
        maxRedemptions: p.maxRedemptions,
        perUserLimit: p.perUserLimit,
        expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
        active: p.active,
        redemptions: countByPromo.get(p.id) ?? 0,
      })),
    );
  }),
);

const promoInputSchema = z.object({
  code: z.string().trim().min(2).max(32),
  kind: z.enum(['percent', 'flat']),
  value: z.number().positive(),
  minSpend: z.number().min(0).default(0),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  perUserLimit: z.number().int().positive().default(1),
  expiresAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
});

/** POST /admin/promos — create a new code. */
router.post(
  '/promos',
  asyncHandler(async (req, res) => {
    const input = promoInputSchema.parse(req.body);
    const db = getDb();
    const [row] = await db
      .insert(promoCodes)
      .values({
        code: input.code.toUpperCase(),
        kind: input.kind,
        value: input.value,
        minSpend: input.minSpend,
        maxRedemptions: input.maxRedemptions ?? null,
        perUserLimit: input.perUserLimit,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        active: input.active,
      })
      .returning();
    res.status(201).json(row);
  }),
);

/**
 * PATCH /admin/promos/:id — edit a code. The usual edit here is deactivating
 * one rather than deleting it — a hard delete would orphan its
 * promo_redemptions history, which is the source of truth for its counts.
 */
router.patch(
  '/promos/:id',
  asyncHandler(async (req, res) => {
    const input = promoInputSchema.partial().parse(req.body);
    const { code, expiresAt, ...rest } = input;
    const patch: Partial<typeof promoCodes.$inferInsert> = { ...rest };
    if (code !== undefined) patch.code = code.toUpperCase();
    if (expiresAt !== undefined) patch.expiresAt = expiresAt ? new Date(expiresAt) : null;

    const db = getDb();
    const [row] = await db.update(promoCodes).set(patch).where(eq(promoCodes.id, param(req, 'id'))).returning();
    if (!row) throw new HttpError(404, 'Promo code not found');
    res.json(row);
  }),
);

/** GET /admin/currencies — every display currency, including inactive ones. */
router.get(
  '/currencies',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(currencies).orderBy(desc(currencies.createdAt));
    res.json(rows);
  }),
);

const currencyInputSchema = z.object({
  code: z.string().trim().min(2).max(6),
  symbol: z.string().trim().min(1).max(4),
  ngnRate: z.number().positive(),
  active: z.boolean().default(true),
});

/** POST /admin/currencies — add a display currency. */
router.post(
  '/currencies',
  asyncHandler(async (req, res) => {
    const input = currencyInputSchema.parse(req.body);
    const db = getDb();
    const [row] = await db
      .insert(currencies)
      .values({ code: input.code.toUpperCase(), symbol: input.symbol, ngnRate: input.ngnRate, active: input.active })
      .returning();
    res.status(201).json(row);
  }),
);

/**
 * PATCH /admin/currencies/:id — edit a rate or toggle active. This only
 * affects display conversion (browsing/preview) — never what's actually
 * charged, so editing a rate mid-checkout can't shift a patient's total.
 */
router.patch(
  '/currencies/:id',
  asyncHandler(async (req, res) => {
    const input = currencyInputSchema.partial().parse(req.body);
    const { code, ...rest } = input;
    const patch: Partial<typeof currencies.$inferInsert> = { ...rest };
    if (code !== undefined) patch.code = code.toUpperCase();

    const db = getDb();
    const [row] = await db.update(currencies).set(patch).where(eq(currencies.id, param(req, 'id'))).returning();
    if (!row) throw new HttpError(404, 'Currency not found');
    res.json(row);
  }),
);

/** GET /admin/content — every content block, for the editor list. */
router.get(
  '/content',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(contentBlocks).orderBy(contentBlocks.key);
    res.json(rows.map((c) => ({ key: c.key, title: c.title, body: c.body, updatedAt: c.updatedAt.toISOString() })));
  }),
);

/**
 * PATCH /admin/content/:key — edit a block's title/body. Keys are fixed (see
 * migrations/0009_content_blocks.sql) — this updates an existing block's
 * text, it doesn't create new ones the app has nowhere to render.
 */
router.patch(
  '/content/:key',
  asyncHandler(async (req, res) => {
    const input = z.object({ title: z.string().min(1).optional(), body: z.string().min(1).optional() }).parse(req.body);
    if (!Object.keys(input).length) throw new HttpError(400, 'Nothing to update.');

    const db = getDb();
    const [row] = await db
      .update(contentBlocks)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(contentBlocks.key, param(req, 'key')))
      .returning();
    if (!row) throw new HttpError(404, 'Content block not found');
    res.json({ key: row.key, title: row.title, body: row.body, updatedAt: row.updatedAt.toISOString() });
  }),
);

// Mirrors routes/me.ts's documentUrl() — same R2-public-base-URL pattern for
// resolving a stored key back to a fetchable link at read time.
function documentUrl(storageKey: string): string {
  const base = env.r2.publicBaseUrl;
  return base ? `${base.replace(/\/$/, '')}/${storageKey}` : storageKey;
}

/** GET /admin/providers/applications — verification queue. */
router.get(
  '/providers/applications',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db.select().from(providerApplications);

    // Resolve the linked doctors row for approved appointment-type
    // applications (Doctor/Nurse/Therapist), so this same list can show/
    // toggle their in-home privilege (task 2.3) — one batched query, not one
    // per row.
    const userIds = rows
      .filter((a) => (APPOINTMENT_PROVIDER_TYPES as readonly string[]).includes(a.type) && a.userId)
      .map((a) => a.userId!);
    const linkedDoctors = userIds.length ? await db.select().from(doctors).where(inArray(doctors.userId, userIds)) : [];
    const doctorByUserId = new Map(linkedDoctors.map((d) => [d.userId, d]));

    // Same for approved Pharmacy applications — a pharmacies row, not a
    // doctors row (Batch 3 Phase 3). Lab/Clinic still get neither.
    const pharmacyUserIds = rows.filter((a) => a.type === 'Pharmacy' && a.userId).map((a) => a.userId!);
    const linkedPharmacies = pharmacyUserIds.length
      ? await db.select().from(pharmacies).where(inArray(pharmacies.userId, pharmacyUserIds))
      : [];
    const pharmacyByUserId = new Map(linkedPharmacies.map((p) => [p.userId, p]));

    res.json(
      rows.map((a) => {
        const linked = a.userId ? doctorByUserId.get(a.userId) : undefined;
        const linkedPharmacy = a.userId ? pharmacyByUserId.get(a.userId) : undefined;
        return {
          id: a.id,
          name: a.name,
          type: a.type,
          specialty: a.specialty,
          location: a.location,
          submittedAt: a.submittedAt,
          checks: { govId: a.checkGovId, email: a.checkEmail, phone: a.checkPhone },
          status: a.status,
          // Only present once approval has actually created a bookable
          // doctors row — undefined (not false) otherwise, so the admin UI
          // can distinguish "not applicable" from "off".
          doctorId: linked?.id,
          canProvideInHome: linked?.canProvideInHome,
          // Only present once approval has created a directory pharmacies
          // row. `pharmacyActive` mirrors canProvideInHome's toggle pattern.
          pharmacyId: linkedPharmacy?.id,
          pharmacyActive: linkedPharmacy?.active,
          spokenLanguages: a.spokenLanguages,
          documents: a.documents.map((d) => ({ ...d, url: documentUrl(d.key) })),
        };
      }),
    );
  }),
);

/**
 * PATCH /admin/providers/applications/:id/checks — set the 3 verification
 * booleans (gov ID / email / phone). Partial patch, not a full replace — an
 * admin ticking one box shouldn't require resending the other two.
 */
router.patch(
  '/providers/applications/:id/checks',
  asyncHandler(async (req, res) => {
    const input = z
      .object({ govId: z.boolean().optional(), email: z.boolean().optional(), phone: z.boolean().optional() })
      .parse(req.body);
    if (!Object.keys(input).length) throw new HttpError(400, 'Nothing to update.');

    const patch: Partial<typeof providerApplications.$inferInsert> = {};
    if (input.govId !== undefined) patch.checkGovId = input.govId;
    if (input.email !== undefined) patch.checkEmail = input.email;
    if (input.phone !== undefined) patch.checkPhone = input.phone;

    const db = getDb();
    const [row] = await db
      .update(providerApplications)
      .set(patch)
      .where(eq(providerApplications.id, param(req, 'id')))
      .returning();
    if (!row) throw new HttpError(404, 'Application not found');
    res.json({ checks: { govId: row.checkGovId, email: row.checkEmail, phone: row.checkPhone } });
  }),
);

/**
 * PATCH /admin/doctors/:id — toggle a bookable provider's in-home care
 * privilege (task 2.3). Deliberately narrow — the only admin-editable doctor
 * field today, not a general doctor-editing endpoint.
 */
router.patch(
  '/doctors/:id',
  asyncHandler(async (req, res) => {
    const { canProvideInHome } = z.object({ canProvideInHome: z.boolean() }).parse(req.body);
    const db = getDb();
    const [row] = await db
      .update(doctors)
      .set({ canProvideInHome })
      .where(eq(doctors.id, param(req, 'id')))
      .returning();
    if (!row) throw new HttpError(404, 'Provider not found');
    res.json({ id: row.id, canProvideInHome: row.canProvideInHome });
  }),
);

/**
 * PATCH /admin/pharmacies/:id — toggle a directory pharmacy active/inactive
 * (Batch 3 Phase 3). Mirrors PATCH /admin/doctors/:id's scope: the only
 * admin-editable field post-approval, not a general pharmacy-editing
 * endpoint — there's no self-service dashboard for a pharmacy to edit its
 * own details this batch.
 */
router.patch(
  '/pharmacies/:id',
  asyncHandler(async (req, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const db = getDb();
    const [row] = await db
      .update(pharmacies)
      .set({ active })
      .where(eq(pharmacies.id, param(req, 'id')))
      .returning();
    if (!row) throw new HttpError(404, 'Pharmacy not found');
    res.json({ id: row.id, active: row.active });
  }),
);

/**
 * Creates the entity a provider type needs once its application is
 * approved. Doctor/Nurse/Therapist all land in the `doctors` table (via the
 * providerType discriminator, Batch 3 Phase 2); Pharmacy lands in its own
 * `pharmacies` table (Phase 3) instead.
 *
 * Returns undefined for a type with no handler yet (Lab/Clinic) — the
 * applicant is still notified of the approval either way (see the route
 * below); they just don't have a live profile until their type's handler
 * lands. Previously every non-Doctor type silently no-op'd here AND skipped
 * notifying the applicant — this function fixes the entity-creation gap; the
 * route fixes the notification gap.
 */
async function createEntityForApproval(
  row: typeof providerApplications.$inferSelect,
): Promise<{ doctorId: string } | { pharmacyId: string } | undefined> {
  if (!row.userId) return undefined;
  const db = getDb();

  if ((APPOINTMENT_PROVIDER_TYPES as readonly string[]).includes(row.type)) {
    const providerType = row.type as (typeof APPOINTMENT_PROVIDER_TYPES)[number];
    const [existing] = await db.select().from(doctors).where(eq(doctors.userId, row.userId));
    if (existing) return { doctorId: existing.id };

    const [created] = await db
      .insert(doctors)
      .values({
        userId: row.userId,
        name: row.name,
        specialty: row.specialty,
        category: row.category ?? row.specialty,
        location: row.location,
        fee: row.fee ?? '₦15,000',
        available: true,
        nextAvailable: '',
        spokenLanguages: row.spokenLanguages,
        providerType,
        // Nurse's primary modality is Home Visit (locked decision) — grant the
        // privilege on approval so they're immediately bookable for it; admin
        // can still revoke via the existing toggle above, same as any Doctor.
        canProvideInHome: providerType === 'Nurse',
      })
      .returning();
    return { doctorId: created!.id };
  }

  if (row.type === 'Pharmacy') {
    const [existing] = await db.select().from(pharmacies).where(eq(pharmacies.userId, row.userId));
    if (existing) return { pharmacyId: existing.id };

    const [user] = await db.select().from(users).where(eq(users.id, row.userId));
    const [created] = await db
      .insert(pharmacies)
      .values({
        userId: row.userId,
        name: row.name,
        // The application's `location` doubles as the pharmacy's directory
        // address — same field, same meaning, no separate address input.
        address: row.location,
        fax: user?.phone ?? '',
      })
      .returning();
    return { pharmacyId: created!.id };
  }

  return undefined;
}

/**
 * POST /admin/providers/applications/:id/decision
 *
 * Approving a Doctor application is what actually creates the bookable
 * `doctors` row and links it to the applicant's account — this is the only
 * path from "signed up as a Doctor" to "appears in search". Idempotent: a
 * second approval won't create a duplicate profile.
 *
 * Every decision notifies the applicant, regardless of provider type — see
 * createEntityForApproval's doc comment for the bug this fixes.
 */
router.post(
  '/providers/applications/:id/decision',
  asyncHandler(async (req, res) => {
    const { decision } = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(req.body);
    const db = getDb();
    const [row] = await db
      .update(providerApplications)
      .set({ status: decision })
      .where(eq(providerApplications.id, param(req, 'id')))
      .returning();
    if (!row) throw new HttpError(404, 'Application not found');

    if (decision === 'rejected') {
      if (row.userId) {
        await notify(
          row.userId,
          'Application Not Approved',
          'Your provider application was not approved. Contact support if you think this is a mistake.',
        );
      }
      res.json({ ok: true });
      return;
    }

    const entity = await createEntityForApproval(row);
    if (row.userId) {
      const message =
        entity && 'doctorId' in entity
          ? 'Your provider application was approved — your profile is now live and patients can book you.'
          : entity && 'pharmacyId' in entity
            ? "Your pharmacy application was approved — you're now listed in our provider directory."
            : "Your provider application was approved. We'll be in touch with next steps to finish setting up your profile.";
      await notify(row.userId, 'Application Approved', message);
    }

    res.json({
      ok: true,
      doctorId: entity && 'doctorId' in entity ? entity.doctorId : undefined,
      pharmacyId: entity && 'pharmacyId' in entity ? entity.pharmacyId : undefined,
    });
  }),
);

/** GET /admin/reviews?status=pending — moderation queue. */
router.get(
  '/reviews',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const db = getDb();
    const rows = await db
      .select()
      .from(reviews)
      .where(eq(reviews.status, status as 'pending' | 'published' | 'removed'));
    res.json(rows);
  }),
);

/** POST /admin/reviews/:id/decision */
router.post(
  '/reviews/:id/decision',
  asyncHandler(async (req, res) => {
    const { decision } = z.object({ decision: z.enum(['published', 'removed']) }).parse(req.body);
    const db = getDb();
    const [row] = await db.update(reviews).set({ status: decision }).where(eq(reviews.id, param(req, 'id'))).returning();
    if (!row) throw new HttpError(404, 'Review not found');
    res.json({ ok: true });
  }),
);

/** GET /admin/complaints?status=pending — support/report queue. */
router.get(
  '/complaints',
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const db = getDb();
    const rows = await db
      .select()
      .from(complaints)
      .where(eq(complaints.status, status as 'pending' | 'resolved' | 'dismissed'))
      .orderBy(desc(complaints.createdAt));
    res.json(
      rows.map((c) => ({
        id: c.id,
        authorName: c.authorName,
        accountType: c.accountType,
        category: c.category,
        subject: c.subject,
        description: c.description,
        appointmentId: c.appointmentId ?? undefined,
        status: c.status,
        resolutionNote: c.resolutionNote ?? undefined,
        submittedAt: c.submittedAt,
      })),
    );
  }),
);

/**
 * POST /admin/complaints/:id/decision — resolve or dismiss a report, with an
 * optional note. The filer is notified either way — a complaint that's only
 * ever tracked internally, with no visible resolution, defeats the point.
 */
router.post(
  '/complaints/:id/decision',
  asyncHandler(async (req, res) => {
    const { decision, resolutionNote } = z
      .object({ decision: z.enum(['resolved', 'dismissed']), resolutionNote: z.string().max(2000).optional() })
      .parse(req.body);
    const db = getDb();
    const [row] = await db
      .update(complaints)
      .set({ status: decision, resolutionNote: resolutionNote ?? null, resolvedAt: new Date() })
      .where(eq(complaints.id, param(req, 'id')))
      .returning();
    if (!row) throw new HttpError(404, 'Report not found');

    await notify(
      row.userId,
      decision === 'resolved' ? 'Your report has been resolved' : 'Update on your report',
      resolutionNote || (decision === 'resolved' ? 'Your report has been marked resolved.' : 'Your report has been reviewed and closed.'),
    );

    res.json({ ok: true });
  }),
);

/** GET /admin/users — user management. */
router.get(
  '/users',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(users)
      .where(inArray(users.accountType, ['Patient', 'Doctor', 'Provider']))
      .orderBy(desc(users.joinedAt));
    res.json(
      rows.map((u) => ({
        id: u.id,
        name: `${u.firstName} ${u.lastName}`,
        email: u.email,
        accountType: u.accountType,
        joined: formatJoined(u.joinedAt),
        status: u.status,
        govId: {
          status: u.govIdStatus,
          fileName: u.govIdFileName ?? undefined,
          url: u.govIdKey ? documentUrl(u.govIdKey) : undefined,
        },
      })),
    );
  }),
);

/**
 * PATCH /admin/users/:id — suspend or reactivate a patient or provider
 * account. Narrow by design, mirrors PATCH /admin/doctors/:id's scope — the
 * only admin-editable field on a user account. Enforcement already exists
 * at every session-issuing route (login, 2FA verify, password reset all
 * check `status === 'suspended'`, routes/auth.ts) — this is what actually
 * lets an admin flip it, closing the gap where the status was only ever
 * displayed, never actionable.
 */
router.patch(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
    const db = getDb();
    const [row] = await db.update(users).set({ status }).where(eq(users.id, param(req, 'id'))).returning();
    if (!row) throw new HttpError(404, 'User not found');
    res.json({ id: row.id, status: row.status });
  }),
);

/**
 * PATCH /admin/users/:id/gov-id — approve or reject a submitted gov-ID
 * document. Only meaningful once status is 'pending' (a submission exists),
 * but doesn't hard-require it — an admin correcting a mistaken decision on
 * an already-verified/rejected account is a legitimate, if rare, case.
 */
router.patch(
  '/users/:id/gov-id',
  asyncHandler(async (req, res) => {
    const { status } = z.object({ status: z.enum(['verified', 'rejected']) }).parse(req.body);
    const db = getDb();
    const [row] = await db.update(users).set({ govIdStatus: status }).where(eq(users.id, param(req, 'id'))).returning();
    if (!row) throw new HttpError(404, 'User not found');
    res.json({ id: row.id, govIdStatus: row.govIdStatus });
  }),
);

/** GET /admin/appointments — all bookings. */
router.get(
  '/appointments',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const rows = await db
      .select({ appt: appointments, patient: users })
      .from(appointments)
      .leftJoin(users, eq(users.id, appointments.patientId))
      .orderBy(desc(appointments.createdAt));

    res.json(
      rows.map(({ appt, patient }) => ({
        id: appt.id,
        patient: patient ? `${patient.firstName} ${patient.lastName}` : 'Unknown',
        provider: appt.doctorName,
        type: appt.type,
        date: `${appt.date} · ${appt.time}`,
        fee: appt.fee ?? '',
        status: appt.status === 'past' ? 'completed' : appt.status,
      })),
    );
  }),
);

export default router;
