import { isValidTimezone } from './business.schemas';

/**
 * Timezone-safe date helpers (no dependency; built on Intl).
 *
 * Rule: instants are stored in UTC; "local" values (date + wall-clock time) are always interpreted in an
 * explicit IANA timezone. Recurring schedules are computed from local wall-clock time so a 09:00 post stays at
 * 09:00 across daylight-saving changes.
 */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** True for a real calendar date (rejects 2026-02-30). */
export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function partsAt(ms: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour! === 24 ? 0 : p.hour!, mi: p.minute!, s: p.second! };
}

/** Offset of the zone from UTC at an instant, in minutes (positive = east of UTC). */
export function offsetMinutesAt(ms: number, tz: string): number {
  const p = partsAt(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

export interface ZonedResult {
  utc: Date;
  /** The wall-clock time did not exist (daylight-saving gap) and was moved forward. */
  shifted: boolean;
  /** The wall-clock time happened twice (daylight-saving overlap); the first occurrence was used. */
  ambiguous: boolean;
}

/** Converts a local date and time in `tz` to the UTC instant. */
export function zonedToUtc(date: string, time: string, tz: string): ZonedResult {
  if (!isValidDate(date) || !TIME_RE.test(time)) throw new RangeError(`Invalid local date/time: ${date} ${time}`);
  if (!isValidTimezone(tz)) throw new RangeError(`Invalid timezone: ${tz}`);
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const day = 86_400_000;
  const offsets = [...new Set([offsetMinutesAt(wall - day, tz), offsetMinutesAt(wall + day, tz)])];
  const valid = offsets
    .map((o) => wall - o * 60_000)
    .filter((utc) => {
      const p = partsAt(utc, tz);
      return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
    })
    .sort((a, b) => a - b);
  if (valid.length) return { utc: new Date(valid[0]!), shifted: false, ambiguous: valid.length > 1 };
  // Gap: use the offset in force before the transition, which lands after the gap.
  const before = offsetMinutesAt(wall - day, tz);
  return { utc: new Date(wall - before * 60_000), shifted: true, ambiguous: false };
}

export interface LocalParts {
  date: string;
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  offsetMinutes: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date, time and weekday of an instant in `tz`. */
export function utcToZoned(at: Date, tz: string): LocalParts {
  const p = partsAt(at.getTime(), tz);
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.mi)}`, weekday: new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay(), offsetMinutes: offsetMinutesAt(at.getTime(), tz) };
}

/** Adds calendar days to a YYYY-MM-DD date (no timezone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole days from `a` to `b` (YYYY-MM-DD). */
export function diffDays(a: string, b: string): number {
  const f = (s: string) => {
    const [y, m, d] = s.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((f(b) - f(a)) / 86_400_000);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** UTC bounds [start, end) of a local day in `tz`. */
export function localDayRange(date: string, tz: string): { start: Date; end: Date } {
  return { start: zonedToUtc(date, '00:00', tz).utc, end: zonedToUtc(addDays(date, 1), '00:00', tz).utc };
}

/** Today's date in `tz`. */
export function todayIn(tz: string, now = new Date()): string {
  return utcToZoned(now, tz).date;
}
