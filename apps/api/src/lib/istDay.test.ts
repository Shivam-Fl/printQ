import { describe, expect, it } from 'vitest';
import { istDayKey, lastIstDayKeys, startOfIstDay } from './istDay.js';

// IST = UTC+05:30. 2026-10-10T18:31Z is 00:01 IST on 2026-10-11.
describe('IST day buckets', () => {
  it('00:01 IST belongs to the new IST day even though the UTC date is still the 10th', () => {
    const at = new Date('2026-10-10T18:31:00Z');
    expect(istDayKey(at)).toBe('2026-10-11');
    expect(startOfIstDay(at).toISOString()).toBe('2026-10-10T18:30:00.000Z');
  });
  it('23:59 IST is still the same IST day', () => {
    const at = new Date('2026-10-11T18:29:00Z');
    expect(istDayKey(at)).toBe('2026-10-11');
    expect(startOfIstDay(at).toISOString()).toBe('2026-10-10T18:30:00.000Z');
  });
  it('exactly midnight IST starts the day; one ms earlier is the previous day', () => {
    expect(istDayKey(new Date('2026-10-10T18:30:00.000Z'))).toBe('2026-10-11');
    expect(istDayKey(new Date('2026-10-10T18:29:59.999Z'))).toBe('2026-10-10');
  });
  it('last 7 days ends on the IST today and has no gaps', () => {
    expect(lastIstDayKeys(7, new Date('2026-10-10T18:31:00Z'))).toEqual([
      '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
    ]);
    expect(lastIstDayKeys(3, new Date('2026-10-11T18:29:00Z'))).toEqual(['2026-10-09', '2026-10-10', '2026-10-11']);
  });
});
