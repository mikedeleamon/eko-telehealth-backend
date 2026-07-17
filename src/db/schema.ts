/**
 * Database schema (Drizzle ORM → Supabase Postgres).
 *
 * Columns intentionally keep the display-ready strings the client contracts
 * expect (fee "₦15,000", date "Mon, Jun 29, 2026") alongside real foreign
 * keys, so the mobile app and admin console work unchanged. Run
 * `npm run db:push` to apply this to your Supabase database.
 */
import { boolean, doublePrecision, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  role: text('role').$type<'Patient' | 'Doctor' | 'Admin'>().notNull().default('Patient'),
  status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
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
  amount: doublePrecision('amount').notNull(),
  currency: text('currency').notNull().default('NGN'),
  checkoutRef: text('checkout_ref').notNull().default(''),
  status: text('status').$type<'pending' | 'succeeded' | 'failed'>().notNull().default('pending'),
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
  text: text('text').notNull(),
  submittedAt: text('submitted_at').notNull(),
  status: text('status').$type<'pending' | 'published' | 'removed'>().notNull().default('pending'),
  // submittedAt is a display string; this is the real sort key.
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

export type UserRow = typeof users.$inferSelect;
export type DoctorRow = typeof doctors.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
export type DependentRow = typeof dependents.$inferSelect;
export type UserSettingsRow = typeof userSettings.$inferSelect;
