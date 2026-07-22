/**
 * The whole platform is hardcoded to one timezone (Africa/Lagos, WAT,
 * UTC+1, no DST) rather than modeling per-user/per-doctor timezones — this
 * matches the all-Nigeria user base and avoids a much bigger lift. Pure
 * arithmetic, no I/O — mirrors lib/format.ts / lib/pricing.ts.
 *
 * Deliberately explicit rather than relying on the server process's `TZ` env
 * var: scheduling math must stay correct even if that's ever misconfigured.
 * (The env var is still set for the process, as a belt-and-suspenders fix
 * for existing display formatters like formatClockTime that DO rely on it.)
 */

export const LAGOS_TZ_NAME = 'Africa/Lagos';
export const LAGOS_UTC_OFFSET_MINUTES = 60;

/** A Lagos calendar date ('YYYY-MM-DD') + minute-of-day -> the real UTC instant. */
export function lagosDateTimeToUtc(date: string, minuteOfDay: number): Date {
  const [year, month, day] = date.split('-').map(Number);
  const utcMinuteOfDay = minuteOfDay - LAGOS_UTC_OFFSET_MINUTES;
  return new Date(Date.UTC(year, month - 1, day, 0, utcMinuteOfDay));
}

/** The [start, end) UTC range covering one Lagos calendar day. */
export function lagosDayRangeUtc(date: string): { start: Date; end: Date } {
  return {
    start: lagosDateTimeToUtc(date, 0),
    end: lagosDateTimeToUtc(date, 24 * 60),
  };
}

/** Weekday (0 = Sunday) of a 'YYYY-MM-DD' string — a calendar date has no time-of-day, so timezone doesn't affect this. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** "Mon, Jun 29, 2026" in Lagos local time, regardless of server TZ. */
export function formatLagosDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    timeZone: LAGOS_TZ_NAME,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "9:00 AM" in Lagos local time, regardless of server TZ. */
export function formatLagosClockTime(d: Date): string {
  return d.toLocaleTimeString('en-US', {
    timeZone: LAGOS_TZ_NAME,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
