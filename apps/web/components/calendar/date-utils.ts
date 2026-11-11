import { addDays, diffDays, weekdayOf } from '@touma/shared';

export { addDays, diffDays, weekdayOf };

/** Monday of the week containing a date (YYYY-MM-DD). */
export function weekStart(date: string) {
  const wd = weekdayOf(date); // 0 = Sunday
  return addDays(date, -((wd + 6) % 7));
}

export function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

export function monthEnd(date: string) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`, -1);
}

export function addMonths(date: string, n: number) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}-01`;
}

/** The 6-week (or 5-week) grid of dates covering a month, Monday first. */
export function monthGrid(date: string) {
  const first = weekStart(monthStart(date));
  const last = addDays(weekStart(monthEnd(date)), 6);
  const days: string[] = [];
  for (let d = first; diffDays(d, last) >= 0; d = addDays(d, 1)) days.push(d);
  return days;
}

const UTC = (d: string) => new Date(`${d}T12:00:00Z`);

export function formatDate(date: string, locale: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts }).format(UTC(date));
}

/** Short weekday names Monday first, in the locale. */
export function weekdayNames(locale: string, style: 'short' | 'long' = 'short') {
  const monday = '2026-01-05';
  return Array.from({ length: 7 }, (_, i) => formatDate(addDays(monday, i), locale, { weekday: style }));
}

export function shiftDate(date: string, view: 'month' | 'week' | 'day', dir: -1 | 1) {
  if (view === 'month') return addMonths(date, dir);
  return addDays(date, dir * (view === 'week' ? 7 : 1));
}
