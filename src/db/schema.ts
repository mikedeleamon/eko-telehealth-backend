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
  status: text('status').$type<'upcoming' | 'past' | 'cancelled'>().notNull().default('upcoming'),
  reason: text('reason'),
  dependentId: text('dependent_id'),
  fee: text('fee'),
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
  name: text('name').notNull(),
  type: text('type').$type<'Doctor' | 'Nurse' | 'Pharmacy' | 'Lab' | 'Therapist' | 'Clinic'>().notNull(),
  specialty: text('specialty').notNull(),
  location: text('location').notNull(),
  submittedAt: text('submitted_at').notNull(),
  checkGovId: boolean('check_gov_id').notNull().default(false),
  checkEmail: boolean('check_email').notNull().default(false),
  checkPhone: boolean('check_phone').notNull().default(false),
  status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
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
});

/** Short-lived OTP / reset codes for /auth/{verify,forgot-password,send-code}. */
export const verificationCodes = pgTable('verification_codes', {
  id: uuid('id').defaultRandom().primaryKey(),
  // Email address or phone number the code was sent to, depending on channel.
  destination: text('destination').notNull(),
  channel: text('channel').$type<'email' | 'sms'>().notNull(),
  code: text('code').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type DoctorRow = typeof doctors.$inferSelect;
export type AppointmentRow = typeof appointments.$inferSelect;
