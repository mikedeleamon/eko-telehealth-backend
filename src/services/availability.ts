import { and, eq, gte, lt, notInArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { appointments, doctorAvailability, doctors, type DoctorAvailabilityRow, type DoctorRow } from '../db/schema';
import { formatLagosClockTime, lagosDateTimeToUtc, lagosDayRangeUtc, weekdayOf } from '../lib/timezone';

export interface AvailableSlot {
  /** ISO instant. */
  startAt: string;
  /** "9:00 AM", Lagos local. */
  label: string;
}

/**
 * Every open slot for a doctor on a given Lagos calendar date: their working
 * hours for that weekday, minus whatever's already booked, minus anything
 * already in the past.
 */
export async function getAvailableSlots(doctorId: string, date: string): Promise<AvailableSlot[]> {
  const db = getDb();
  const weekday = weekdayOf(date);

  const blocks = await db
    .select()
    .from(doctorAvailability)
    .where(and(eq(doctorAvailability.doctorId, doctorId), eq(doctorAvailability.weekday, weekday)));
  if (!blocks.length) return [];

  const { start, end } = lagosDayRangeUtc(date);
  const booked = await db
    .select({ startAt: appointments.startAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        gte(appointments.startAt, start),
        lt(appointments.startAt, end),
        // Same exclusion set as the partial unique index in
        // migrations/0013 — kept identical on purpose, or a slot could show
        // as free here while the DB still rejects the insert (or vice versa).
        notInArray(appointments.status, ['cancelled', 'declined']),
      ),
    );
  const bookedTimes = new Set(booked.map((b) => b.startAt!.toISOString()));

  const now = new Date();
  const slots: AvailableSlot[] = [];
  for (const block of blocks) {
    for (let minute = block.startMinute; minute + block.slotMinutes <= block.endMinute; minute += block.slotMinutes) {
      const startAt = lagosDateTimeToUtc(date, minute);
      if (startAt <= now) continue;
      if (bookedTimes.has(startAt.toISOString())) continue;
      slots.push({ startAt: startAt.toISOString(), label: formatLagosClockTime(startAt) });
    }
  }
  // `blocks` has no ORDER BY, so a split-shift doctor (e.g. 9-12 and 2-6) can
  // come back in either order from Postgres — sort here so callers can rely
  // on chronological order (findNextAvailable takes slots[0] as "earliest").
  slots.sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0));
  return slots;
}

/** Whether `startAt` is a real, currently-open slot for this doctor — the server-side booking gate. */
export async function isSlotAvailable(doctorId: string, startAt: Date): Promise<boolean> {
  const date = formatLagosCalendarDate(startAt);
  const slots = await getAvailableSlots(doctorId, date);
  return slots.some((s) => s.startAt === startAt.toISOString());
}

/** 'YYYY-MM-DD' for a UTC instant, read as a Lagos calendar date. */
function formatLagosCalendarDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }); // en-CA gives YYYY-MM-DD
}

/** The Lagos calendar date `dayOffset` days from now (0 = today, Lagos local). */
function lagosDateOffset(dayOffset: number): string {
  return formatLagosCalendarDate(new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000));
}

export interface NextAvailableMatch {
  doctor: DoctorRow;
  slot: AvailableSlot;
}

/**
 * The earliest open slot across every eligible doctor in a category, within
 * the next `maxDaysAhead` days ("Book Next Available" — flexible provider
 * selection). Ties broken by higher `rating`. Returns null when nobody has an
 * opening in the window — a normal empty outcome (a category can genuinely
 * be fully booked for two weeks), not an error.
 *
 * `available` (the doctor's own "accepting bookings" toggle) is part of
 * eligibility here — it's separate from real slot data, so a doctor who
 * turned themselves off must not still be auto-assignable. Home Visit isn't
 * excluded despite having no geography matching anywhere in this app yet —
 * the existing manual Home Visit flow has that exact same gap today, so
 * auto-assign doesn't make anything worse. The tie-break has no distance
 * term for the same reason; add one here once geo-matching exists anywhere,
 * rather than rediscovering this gap by incident report.
 *
 * Sequential per-doctor/per-day queries, not a batched multi-doctor query —
 * an accepted v1 tradeoff (no existing batched-query pattern in this
 * codebase to build one on, and the common case — someone free within a day
 * or two — is cheap). Do not parallelize with Promise.all without a
 * concurrency cap: unbounded fan-out under concurrent match requests for a
 * popular category is the real risk here, not the sequential case.
 */
export async function findNextAvailable(
  category: string,
  type: 'Video Visit' | 'Clinic Visit' | 'Home Visit',
  maxDaysAhead = 14,
): Promise<NextAvailableMatch | null> {
  const db = getDb();
  const eligible = await db
    .select()
    .from(doctors)
    .where(
      type === 'Home Visit'
        ? and(eq(doctors.category, category), eq(doctors.available, true), eq(doctors.canProvideInHome, true))
        : and(eq(doctors.category, category), eq(doctors.available, true)),
    );
  if (!eligible.length) return null;

  for (let dayOffset = 0; dayOffset < maxDaysAhead; dayOffset++) {
    const date = lagosDateOffset(dayOffset);
    let best: NextAvailableMatch | null = null;
    for (const doctor of eligible) {
      const slots = await getAvailableSlots(doctor.id, date);
      if (!slots.length) continue;
      // Chronological order (see getAvailableSlots), so the first slot is this doctor's earliest for the day.
      const candidate = slots[0];
      if (
        !best ||
        candidate.startAt < best.slot.startAt ||
        (candidate.startAt === best.slot.startAt && doctor.rating > best.doctor.rating)
      ) {
        best = { doctor, slot: candidate };
      }
    }
    if (best) return best;
  }
  return null;
}

export async function getDoctorAvailability(doctorId: string): Promise<DoctorAvailabilityRow[]> {
  const db = getDb();
  return db.select().from(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId));
}

export interface AvailabilityBlockInput {
  weekday: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}

/** Full-replace: a doctor's whole weekly schedule is edited and saved as one unit, not per-block. */
export async function setDoctorAvailability(
  doctorId: string,
  blocks: AvailabilityBlockInput[],
): Promise<DoctorAvailabilityRow[]> {
  const db = getDb();
  await db.delete(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId));
  if (!blocks.length) return [];
  return db
    .insert(doctorAvailability)
    .values(blocks.map((b) => ({ doctorId, ...b })))
    .returning();
}
