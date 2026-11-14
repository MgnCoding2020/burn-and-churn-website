import { describe, expect, it } from 'vitest';
import { clock, DEFAULT_HOURS, hoursSummary, openNow } from '../../src/lib/published';
import type { StoreHoursDay } from '../../src/lib/sharepoint';

const week = (f: (d: StoreHoursDay) => Partial<StoreHoursDay>) =>
  DEFAULT_HOURS.map((d) => ({ ...d, ...f(d) }));

describe('showing opening hours (ADR-0045)', () => {
  it('formats 24-hour times for people', () => {
    expect([clock('07:00'), clock('12:30'), clock('20:00'), clock('00:15')]).toEqual([
      '7:00 AM',
      '12:30 PM',
      '8:00 PM',
      '12:15 AM',
    ]);
  });

  it('the same hours every day read "Open daily"', () => {
    expect(hoursSummary(DEFAULT_HOURS)).toEqual([
      { label: 'Open daily', hours: '7:00 AM – 8:00 PM' },
    ]);
  });

  it('groups runs of days with the same hours, and says Closed', () => {
    const hours = week((d) =>
      d.dayOfWeek === 7
        ? { closed: true, opens: null, closes: null }
        : d.dayOfWeek === 6
          ? { opens: '08:00', closes: '18:00' }
          : {},
    );
    expect(hoursSummary(hours)).toEqual([
      { label: 'Monday to Friday', hours: '7:00 AM – 8:00 PM' },
      { label: 'Saturday', hours: '8:00 AM – 6:00 PM' },
      { label: 'Sunday', hours: 'Closed' },
    ]);
  });

  it('knows whether the café is open, in the store time zone (America/New_York)', () => {
    // 2026-11-16 is a Monday. 12:00 UTC = 7:00 AM in New York (EST).
    expect(openNow(DEFAULT_HOURS, new Date('2026-11-16T11:59:00Z'))).toBe(false);
    expect(openNow(DEFAULT_HOURS, new Date('2026-11-16T12:00:00Z'))).toBe(true);
    // 8:00 PM New York = 01:00 UTC the next day: closed at closing time.
    expect(openNow(DEFAULT_HOURS, new Date('2026-11-17T00:59:00Z'))).toBe(true);
    expect(openNow(DEFAULT_HOURS, new Date('2026-11-17T01:00:00Z'))).toBe(false);
    const sundayClosed = week((d) => (d.dayOfWeek === 7 ? { closed: true } : {}));
    expect(openNow(sundayClosed, new Date('2026-11-15T16:00:00Z'))).toBe(false);
  });
});
