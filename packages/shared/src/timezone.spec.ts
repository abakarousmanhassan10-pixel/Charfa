import { isValidTimezone } from './business.schemas';
import { addDays, diffDays, isValidDate, localDayRange, utcToZoned, zonedToUtc } from './timezone';

describe('timezone helpers', () => {
  it('validates zones and dates', () => {
    expect(isValidTimezone('Africa/Ndjamena')).toBe(true);
    expect(isValidTimezone('Mars/Base')).toBe(false);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
  });

  it('converts local time to UTC in zones east and west of UTC', () => {
    expect(zonedToUtc('2026-06-15', '09:00', 'Africa/Ndjamena').utc.toISOString()).toBe('2026-06-15T08:00:00.000Z'); // UTC+1
    expect(zonedToUtc('2026-06-15', '09:00', 'America/New_York').utc.toISOString()).toBe('2026-06-15T13:00:00.000Z'); // EDT
    expect(zonedToUtc('2026-01-15', '09:00', 'America/New_York').utc.toISOString()).toBe('2026-01-15T14:00:00.000Z'); // EST
    expect(zonedToUtc('2026-06-15', '09:00', 'Asia/Kolkata').utc.toISOString()).toBe('2026-06-15T03:30:00.000Z'); // UTC+5:30
  });

  it('keeps wall-clock time across a daylight-saving change', () => {
    const before = zonedToUtc('2026-03-07', '09:00', 'America/New_York').utc; // EST
    const after = zonedToUtc('2026-03-09', '09:00', 'America/New_York').utc; // EDT
    expect(utcToZoned(before, 'America/New_York').time).toBe('09:00');
    expect(utcToZoned(after, 'America/New_York').time).toBe('09:00');
    expect(after.getTime() - before.getTime()).toBe(47 * 3_600_000); // one hour shorter than 48h
  });

  it('handles the spring-forward gap by moving forward', () => {
    const r = zonedToUtc('2026-03-08', '02:30', 'America/New_York');
    expect(r.shifted).toBe(true);
    expect(utcToZoned(r.utc, 'America/New_York').time).toBe('03:30');
  });

  it('handles the fall-back overlap by using the first occurrence', () => {
    const r = zonedToUtc('2026-11-01', '01:30', 'America/New_York');
    expect(r.ambiguous).toBe(true);
    expect(r.utc.toISOString()).toBe('2026-11-01T05:30:00.000Z'); // EDT, the first 01:30
  });

  it('round-trips and reports weekday and local date across midnight', () => {
    const utc = new Date('2026-06-15T23:30:00Z');
    const lagos = utcToZoned(utc, 'Africa/Lagos'); // UTC+1 → next day
    expect(lagos).toMatchObject({ date: '2026-06-16', time: '00:30', weekday: 2 });
    const honolulu = utcToZoned(utc, 'Pacific/Honolulu');
    expect(honolulu).toMatchObject({ date: '2026-06-15', time: '13:30' });
    expect(zonedToUtc(lagos.date, lagos.time, 'Africa/Lagos').utc.toISOString()).toBe(utc.toISOString());
  });

  it('computes day arithmetic and local day bounds (23h and 25h days)', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(diffDays('2026-01-01', '2026-01-31')).toBe(30);
    const spring = localDayRange('2026-03-08', 'America/New_York');
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const fall = localDayRange('2026-11-01', 'America/New_York');
    expect((fall.end.getTime() - fall.start.getTime()) / 3_600_000).toBe(25);
  });

  it('rejects invalid input', () => {
    expect(() => zonedToUtc('2026-13-01', '09:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtc('2026-01-01', '25:00', 'UTC')).toThrow(RangeError);
    expect(() => zonedToUtc('2026-01-01', '09:00', 'Nope/Zone')).toThrow(RangeError);
  });
});
