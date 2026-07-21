/**
 * Database schema (Drizzle ORM → Supabase Postgres).
 *
 * Columns intentionally keep the display-ready strings the client contracts
 * expect (fee "₦15,000", date "Mon, Jun 29, 2026") alongside real foreign
 * keys, so the mobile app and admin console work unchanged. Run
 * `npm run db:push` to apply this to your Supabase database.
 */
import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** An append-only addendum stored in medical_notes.amendments (jsonb array). */
export interface NoteAmendment {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  createdAt: string;
}

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  email: text('email').notNull().unique(),
  // Normalized MSISDN (e.g. 2348012345678) — see normalizeMsisdn in
  // services/sms.ts. Stored normalized so SMS password reset resolves the
  // account however the number was typed. Nullable: seeded and admin accounts
  // predate phone capture and reset by email instead.
  phone: text('phone').unique(),
  passwordHash: text('password_hash').notNull(),
  // The account's permission type. Resolved from this column at login; the
  // client never sends it. Admins sign in through the admin console only.
  accountType: text('account_type').$type<'Patient' | 'Doctor' | 'Admin'>().notNull().default('Patient'),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
  // True for every row by construction: accounts are only created by
  // /auth/verify promoting a pending_signups row, so a user cannot exist
  // without a verified email. Kept as an explicit record of that.
  emailVerified: boolean('email_verified').notNull().default(false),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
});

export const doctors = pgTable('doctors', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  specialty: text('specialty').notNull(),
  category: text('category').notNull(),
  rating: doublePrecision('rating').notNull().default(0),
  reviews: integer('reviews').notNull().default(0),
  location: text('location').notNull(),
  fee: text('fee').notNull(),
  available: boolean('available').notNull().default(true),
  nextAvailable: text('next_available').notNull().default(''),
  avatar: text('avatar'),
});

export const appointments = pgTable('appointments', {
  id: uuid('id').defaultRandom().primaryKey(),
  patientId: uuid('patient_id')
    .references(() => users.id)
    .notNull(),
  doctorId: uuid('doctor_id').references(() => doctors.id),
  doctorName: text('doctor_name').notNull(),
  specialty: text('specialty').notNull(),
  date: text('date').notNull(),
  time: text('time').notNull(),
  type: text('type').$type<'Video Visit' | 'Clinic Visit' | 'Home Visit'>().notNull(),
  /**
   * Booking lifecycle:
   *   pending_approval → the doctor has not accepted yet (initial state)
   *   pending_payment  → accepted; awaiting the patient's payment
   *   upcoming         → paid + confirmed (set only by a verified payment webhook)
   *   declined         → the doctor rejected the request
   *   cancelled        → the patient cancelled
   *   past             → the visit happened
   */
  status: text('status')
    .$type<'pending_approval' | 'pending_payment' | 'upcoming' | 'declined' | 'cancelled' | 'past'>()
    .notNull()
    .default('pending_approval'),
  reason: text('reason'),
  /** Set when booking on behalf of a dependent (proxy access). */
  dependentId: uuid('dependent_id'),
  fee: text('fee'),
  /** Why the doctor declined — shown to the patient. */
  declineReason: text('decline_reason'),
  /** When the doctor accepted; starts the payment window. */
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const conversations = pgTable('conversations', {
  id: uuid('id').defaultRandom().primaryKey(),
  patientId: uuid('patient_id')
    .references(() => users.id)
    .notNull(),
  doctorId: uuid('doctor_id')
    .references(() => doctors.id)
    .notNull(),
  lastMessage: text('last_message').notNull().default(''),
  unread: integer('unread').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  conversationId: uuid('conversation_id')
    .references(() => conversations.id)
    .notNull(),
  senderId: uuid('sender_id')
    .references(() => users.id)
    .notNull(),
  text: text('text').notNull(),
  /**
   * Stream's own message id. Stream ids are arbitrary strings, so they cannot
   * live in the uuid PK above — the webhook used to write them there and every
   * insert threw. Unique so webhook retries dedupe on it instead.
   */
  streamId: text('stream_id').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const notifications = pgTable('notifications', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Doctor-side patient roster (GET /practice/patients). */
export const rosterPatients = pgTable('roster_patients', {
  id: uuid('id').defaultRandom().primaryKey(),
  doctorId: uuid('doctor_id')
    .references(() => doctors.id)
    .notNull(),
  name: text('name').notNull(),
  age: integer('age').notNull(),
  gender: text('gender').notNull(),
  condition: text('condition').notNull(),
  lastVisit: text('last_visit').notNull(),
  /**
   * The real account this roster entry belongs to, when the patient has one.
   * Nullable — many roster entries are walk-ins or demo-only names with no
   * app account. When set, doctor-authored records (prescriptions, labs,
   * medical notes) are stored against THIS id instead of the roster row's own
   * id, so they surface in the patient's own self-view (/me/*). See
   * resolvePatientId in routes/practice.ts.
   */
  userId: uuid('user_id').references(() => users.id),
});

/** Doctor-side agenda rows (GET /practice/agenda). */
export const agendaItems = pgTable('agenda_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  doctorId: uuid('doctor_id')
    .references(() => doctors.id)
    .notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  time: text('time').notNull(),
  status: text('status').$type<'confirmed' | 'cancelled' | 'rescheduled' | 'pending'>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const payments = pgTable('payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  appointmentId: uuid('appointment_id').references(() => appointments.id),
  provider: text('provider').$type<'flutterwave' | 'paypal'>().notNull(),
  // doublePrecision (not integer) so PayPal amounts can carry cents (e.g. 9.38).
  // What was actually charged at the gateway — patientTotal in NGN for
  // Flutterwave, or its USD conversion for PayPal. See the breakdown columns
  // below for the canonical-NGN fee split amount/currency is derived from.
  amount: doublePrecision('amount').notNull(),
  currency: text('currency').notNull().default('NGN'),
  checkoutRef: text('checkout_ref').notNull().default(''),
  status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
  /**
   * Fee breakdown, in canonical NGN (see lib/pricing.ts computeFeeBreakdown),
   * independent of amount/currency above. Nullable: rows created before the
   * pricing engine (migrations/0003_pricing_and_earnings.sql) predate the
   * split — that migration backfills them (amount as consultationFee,
   * nothing withheld) instead of leaving them null.
   */
  consultationFee: doublePrecision('consultation_fee'),
  serviceCharge: doublePrecision('service_charge'),
  /**
   * Patient-borne VAT, added to patientTotal on top of the fee — never
   * withheld from the provider. Zero for Clinic Visit / Home Visit; only
   * Video Visit is VAT-able. See lib/pricing.ts.
   */
  vat: doublePrecision('vat'),
  /** Discount from a promo code (task 0.2). Only ever eats into the platform's own share — never VAT or provider payout. */
  discount: doublePrecision('discount').notNull().default(0),
  /** The promo code applied at checkout (uppercased), if any — see services/promos.ts. Null when discount is 0. */
  promoCode: text('promo_code'),
  providerCommission: doublePrecision('provider_commission'),
  /** consultationFee − providerCommission. What routes/webhooks.ts credits to earnings_ledger. */
  providerPayout: doublePrecision('provider_payout'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Admin-managed discount codes (task 0.2). `value` is a fraction (0.20) for
 * kind:'percent' or a flat NGN amount for kind:'flat'. Redemption counts are
 * NOT stored here — they're derived by counting promo_redemptions rows (the
 * same "sum the ledger" pattern as earningsLedger), so a count can never
 * drift from reality.
 */
export const promoCodes = pgTable('promo_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Stored uppercased; matched case-insensitively by uppercasing the input. */
  code: text('code').notNull().unique(),
  kind: text('kind').$type<'percent' | 'flat'>().notNull(),
  value: doublePrecision('value').notNull(),
  /** Minimum consultationFee + serviceCharge (pre-VAT) to qualify. */
  minSpend: doublePrecision('min_spend').notNull().default(0),
  /** Total redemptions allowed across all patients. Null = unlimited. */
  maxRedemptions: integer('max_redemptions'),
  /** Redemptions allowed per patient. */
  perUserLimit: integer('per_user_limit').notNull().default(1),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One row per SETTLED redemption — never written for an abandoned checkout
 * (see services/promos.ts recordPromoRedemption, called only from
 * webhooks.ts once a payment has actually succeeded). This is what
 * maxRedemptions/perUserLimit are checked against, so browsing with a code
 * applied can never exhaust a limited code's supply.
 */
export const promoRedemptions = pgTable('promo_redemptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  promoId: uuid('promo_id')
    .references(() => promoCodes.id)
    .notNull(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),
  paymentId: uuid('payment_id')
    .references(() => payments.id)
    .notNull(),
  discount: doublePrecision('discount').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Single-row table of the platform's fee-schedule rates (service charge /
 * commission / VAT — see lib/pricing.ts). Admin-managed (GET/PATCH
 * /admin/settings, task 0.1.f). Read via services/platformSettings.ts, which
 * seeds this row with defaults on first read if it's ever found empty.
 */
export const platformSettings = pgTable('platform_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  serviceChargePct: doublePrecision('service_charge_pct').notNull().default(0),
  commissionPct: doublePrecision('commission_pct').notNull().default(0.175),
  vatPct: doublePrecision('vat_pct').notNull().default(0.075),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The doctor wallet: one row per earning (a visit's payout, credited when
 * webhooks.ts confirms payment) or withdrawal (routes/practice.ts POST
 * /payouts). GET /practice/earnings derives balance/pending/thisMonth from
 * this table — see summarizeEarnings in routes/practice.ts, which mirrors
 * the app's mock (mockApi.ts) so the client contract is unchanged.
 *
 * date/time are display strings (not derived from createdAt) so an earning
 * row shows the visit's own date/time rather than the moment it settled —
 * consistent with how appointments.date/time and doctors.fee are stored:
 * display-ready strings alongside the real foreign keys (see the note at the
 * top of this file).
 */
export const earningsLedger = pgTable('earnings_ledger', {
  id: uuid('id').defaultRandom().primaryKey(),
  doctorId: uuid('doctor_id')
    .references(() => doctors.id)
    .notNull(),
  kind: text('kind').$type<'earning' | 'withdrawal'>().notNull(),
  /** Patient name for an earning, or a withdrawal label — mirrors EarningItem.title on the client. */
  title: text('title').notNull(),
  date: text('date').notNull(),
  time: text('time').notNull(),
  /** Positive NGN amount; `kind` decides the sign shown. */
  amount: doublePrecision('amount').notNull(),
  status: text('status').$type<'settled' | 'pending'>().notNull().default('settled'),
  /** The visit this earning was credited for. Null for withdrawals. */
  appointmentId: uuid('appointment_id').references(() => appointments.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Admin verification queue (GET /admin/providers/applications). */
export const providerApplications = pgTable('provider_applications', {
  id: uuid('id').defaultRandom().primaryKey(),
  /**
   * The applicant's account. Nullable because seeded/back-office applications
   * predate self-service; approval can only create a linked doctors row when
   * this is set.
   */
  userId: uuid('user_id').references(() => users.id),
  name: text('name').notNull(),
  type: text('type').$type<'Doctor' | 'Nurse' | 'Pharmacy' | 'Lab' | 'Therapist' | 'Clinic'>().notNull(),
  specialty: text('specialty').notNull(),
  /** Search bucket for the doctors row created on approval (e.g. "Cardiology"). */
  category: text('category'),
  /** Display fee carried onto the doctors row, e.g. "₦15,000". */
  fee: text('fee'),
  location: text('location').notNull(),
  submittedAt: text('submitted_at').notNull(),
  checkGovId: boolean('check_gov_id').notNull().default(false),
  checkEmail: boolean('check_email').notNull().default(false),
  checkPhone: boolean('check_phone').notNull().default(false),
  status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Admin two-way review moderation queue (GET /admin/reviews). */
export const reviews = pgTable('reviews', {
  id: uuid('id').defaultRandom().primaryKey(),
  author: text('author').notNull(),
  subject: text('subject').notNull(),
  direction: text('direction').$type<'patient→provider' | 'provider→patient'>().notNull(),
  rating: integer('rating').notNull(),
  /** Optional App Store-style headline for the review. */
  title: text('title'),
  text: text('text').notNull(),
  /** The author completed a consultation with the subject (badge on the card). */
  verified: boolean('verified').notNull().default(false),
  /** Display-only count of comments/replies on the review. */
  commentsCount: integer('comments_count').notNull().default(0),
  submittedAt: text('submitted_at').notNull(),
  status: text('status').$type<'pending' | 'published' | 'removed'>().notNull().default('pending'),
  // submittedAt is a display string; this is the real sort key.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Signups awaiting email verification.
 *
 * Deliberately NOT in `users`: an unfinished signup must not create a real
 * account. Keeping it here means a half-finished signup holds no session and no
 * data, and re-submitting one (the user went back to fix a field) replaces this
 * row instead of colliding with a real account. /auth/verify promotes a row
 * here into `users` and deletes it — the only path that creates an account.
 */
export const pendingSignups = pgTable('pending_signups', {
  id: uuid('id').defaultRandom().primaryKey(),
  /** Lowercased, matching users.email. Unique so a resubmit upserts. */
  email: text('email').notNull().unique(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  /**
   * Normalized MSISDN. NOT unique (unlike users.phone): two abandoned signups
   * may share a number, and blocking that would let anyone permanently reserve
   * someone else's phone. Uniqueness is re-checked when promoting to `users`.
   */
  phone: text('phone'),
  passwordHash: text('password_hash').notNull(),
  accountType: text('account_type').$type<'Patient' | 'Doctor'>().notNull().default('Patient'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Short-lived OTP / reset codes for /auth/{verify,forgot-password,send-code}. */
export const verificationCodes = pgTable('verification_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Email address or normalized phone the code was sent to, per channel.
  destination: text('destination').notNull(),
  channel: text('channel').$type<'email' | 'sms'>().notNull(),
  code: text('code').notNull(),
  // Failed guesses against this destination. A 6-digit code is only a million
  // possibilities, so without a cap it is brute-forceable inside the 15-minute
  // window; codes are burned once this hits MAX_CODE_ATTEMPTS.
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * People a patient can book on behalf of (proxy access). appointments
 * .dependentId points here; the visit still belongs to the account holder.
 */
export const dependents = pgTable('dependents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  /** Display string, matching how the app collects it (DD-MM-YYYY). */
  dob: text('dob').notNull(),
  relationship: text('relationship'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One insurance record per user (GET/PUT /me/insurance). */
export const insuranceInfo = pgTable('insurance_info', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull()
    .unique(),
  provider: text('provider').notNull(),
  memberId: text('member_id').notNull(),
  groupNumber: text('group_number'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** One preferred pharmacy per user (GET/PUT /me/pharmacy). */
export const pharmacyPreferences = pgTable('pharmacy_preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull()
    .unique(),
  name: text('name'),
  address: text('address').notNull(),
  fax: text('fax').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Per-user preferences (GET/PATCH /me/settings). Notification flags are
 * advisory for future push/email fan-out — OTP and other transactional
 * messages are always delivered regardless of these.
 */
export const userSettings = pgTable('user_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull()
    .unique(),
  pushNotifications: boolean('push_notifications').notNull().default(true),
  emailNotifications: boolean('email_notifications').notNull().default(true),
  smsNotifications: boolean('sms_notifications').notNull().default(false),
  darkMode: boolean('dark_mode').notNull().default(false),
  locationAccess: boolean('location_access').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Doctor "Documents & Certifications" — uploaded credentials (license, board
 * certifications, government ID, etc.). The file bytes live in R2; this row is
 * the metadata. Scoped to the uploading user.
 */
export const documents = pgTable('documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),
  name: text('name').notNull(),
  category: text('category')
    .$type<'license' | 'certification' | 'government-id' | 'insurance' | 'other'>()
    .notNull()
    .default('other'),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  /** R2 object key returned by the presign step; null in unusual states. */
  storageKey: text('storage_key'),
  uploadedAt: text('uploaded_at').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A prescription on a patient's medication record. `patientId` holds a roster
 * patient id when written by a doctor (practice routes) or a user id for a
 * patient's own record (/me/prescriptions) — two different id spaces, so no FK.
 * See the roster/users split noted on rosterPatients.
 */
export const prescriptions = pgTable('prescriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  patientId: uuid('patient_id').notNull(),
  drug: text('drug').notNull(),
  strength: text('strength').notNull(),
  form: text('form').notNull(),
  route: text('route').notNull(),
  frequency: text('frequency').notNull(),
  duration: text('duration').notNull(),
  quantity: text('quantity').notNull(),
  refills: text('refills').notNull(),
  instructions: text('instructions'),
  status: text('status').$type<'active' | 'completed' | 'discontinued'>().notNull().default('active'),
  doctorId: uuid('doctor_id').references(() => doctors.id),
  doctorName: text('doctor_name').notNull(),
  datePrescribed: text('date_prescribed').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Lab results on a patient's record. Like prescriptions, `patientId` holds a
 * roster-patient id (doctor-entered) or a user id (patient self-entered) — no
 * FK. Fields follow lab record-keeping best practice.
 */
export const labs = pgTable('labs', {
  id: uuid('id').defaultRandom().primaryKey(),
  patientId: uuid('patient_id').notNull(),
  testName: text('test_name').notNull(),
  loincCode: text('loinc_code'),
  specimen: text('specimen').notNull(),
  value: text('value').notNull(),
  unit: text('unit'),
  referenceRange: text('reference_range'),
  flag: text('flag').$type<'normal' | 'low' | 'high' | 'critical' | 'abnormal'>().notNull().default('normal'),
  status: text('status').$type<'ordered' | 'collected' | 'resulted'>().notNull().default('resulted'),
  orderedBy: text('ordered_by'),
  performingLab: text('performing_lab'),
  collectedDate: text('collected_date').notNull(),
  resultedDate: text('resulted_date'),
  notes: text('notes'),
  /** R2 object key + original file name for an attached report, when present. */
  attachmentKey: text('attachment_key'),
  attachmentName: text('attachment_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * SOAP-format medical records, shared across a patient's treating doctors.
 * A 'final' record is immutable — corrections are appended to `amendments`,
 * never edited in place. A 'draft' record is still editable by its author.
 * `patientId` holds a roster-patient id (no FK, like prescriptions/labs).
 */
export const medicalNotes = pgTable('medical_notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  patientId: uuid('patient_id').notNull(),
  appointmentId: text('appointment_id').notNull(),
  date: text('date').notNull(),
  visitType: text('visit_type'),
  doctorId: uuid('doctor_id').references(() => doctors.id),
  doctorName: text('doctor_name').notNull(),
  doctorSpecialty: text('doctor_specialty').notNull().default(''),
  reason: text('reason').notNull(),
  subjective: text('subjective').notNull().default(''),
  objective: text('objective').notNull().default(''),
  assessment: text('assessment').notNull().default(''),
  primaryDiagnosis: text('primary_diagnosis'),
  secondaryDiagnoses: jsonb('secondary_diagnoses').$type<string[]>().notNull().default([]),
  plan: text('plan').notNull().default(''),
  status: text('status').$type<'draft' | 'final'>().notNull().default('final'),
  amendments: jsonb('amendments').$type<NoteAmendment[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type DoctorRow = typeof doctors.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
export type DependentRow = typeof dependents.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type PrescriptionRow = typeof prescriptions.$inferSelect;
export type LabRow = typeof labs.$inferSelect;
export type MedicalNoteRow = typeof medicalNotes.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type PlatformSettingsRow = typeof platformSettings.$inferSelect;
export type EarningsLedgerRow = typeof earningsLedger.$inferSelect;
export type PromoCodeRow = typeof promoCodes.$inferSelect;
export type PromoRedemptionRow = typeof promoRedemptions.$inferSelect;
