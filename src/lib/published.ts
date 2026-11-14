import { getMenuSnapshot, type Menu } from './menu';
import type { StoreHoursDay } from './sharepoint';
import { readSnapshot } from './sync';

/**
 * What the site shows comes from SharePoint's published copy (plan §5,
 * ADR-0045): the last good snapshot the sync stored in D1. Until a list has
 * ever synced (previews, local, before the trial), the built-in copy is used,
 * which matches what `setup-sharepoint.ps1 -Seed` puts in the lists.
 *
 * A snapshot was validated before it was stored (ADR-0039); it's checked for
 * shape again here, so a bad row in D1 can only ever mean "use the built-in copy".
 */

/** The built-in hours: the same as the StoreHours list's seed rows. */
export const DEFAULT_HOURS: StoreHoursDay[] = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
].map((day, i) => ({
  day,
  dayOfWeek: i + 1,
  opens: '07:00',
  closes: '20:00',
  closed: false,
  note: null,
}));

const isMenu = (m: unknown): m is Menu =>
  Boolean(m) &&
  Array.isArray((m as Menu).items) &&
  Array.isArray((m as Menu).categories) &&
  (m as Menu).items.length > 0 &&
  (m as Menu).items.every((i) => typeof i.id === 'string' && Array.isArray(i.variants));

const isHours = (h: unknown): h is StoreHoursDay[] =>
  Array.isArray(h) &&
  h.length > 0 &&
  h.every((d) => typeof d?.dayOfWeek === 'number' && typeof d?.closed === 'boolean');

/** The published menu: SharePoint's last good copy, or the built-in one. */
export async function publishedMenu(db: D1Database | undefined): Promise<Menu> {
  if (db) {
    const snap = await readSnapshot<unknown>(db, 'Menu').catch(() => undefined);
    if (isMenu(snap)) return snap;
  }
  return getMenuSnapshot();
}

/** The published opening hours, Monday first: SharePoint's last good copy, or the built-in ones. */
export async function publishedHours(db: D1Database | undefined): Promise<StoreHoursDay[]> {
  if (db) {
    const snap = await readSnapshot<unknown>(db, 'StoreHours').catch(() => undefined);
    if (isHours(snap)) return [...snap].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  }
  return DEFAULT_HOURS;
}

// ---------------------------------------------------------------- showing hours

const STORE_TIME_ZONE = 'America/New_York';

/** "07:00" to "7:00 AM". */
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

const range = (d: StoreHoursDay) =>
  d.closed || !d.opens || !d.closes ? 'Closed' : `${clock(d.opens)} – ${clock(d.closes)}`;

/** Days with the same hours grouped: "Open daily", or one line per run of days. */
export function hoursSummary(days: StoreHoursDay[]): { label: string; hours: string }[] {
  if (days.length === 7 && days.every((d) => range(d) === range(days[0]!))) {
    return [{ label: days[0]!.closed ? 'Closed this week' : 'Open daily', hours: range(days[0]!) }];
  }
  const out: { label: string; hours: string; first: string; last: string }[] = [];
  for (const d of days) {
    const prev = out.at(-1);
    if (prev && prev.hours === range(d)) prev.last = d.day;
    else out.push({ label: '', hours: range(d), first: d.day, last: d.day });
  }
  return out.map((g) => ({
    label: g.first === g.last ? g.first : `${g.first} to ${g.last}`,
    hours: g.hours,
  }));
}

/** Whether the café is open at `now`, in the store's time zone. */
export function openNow(days: StoreHoursDay[], now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TIME_ZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const time = `${get('hour')}:${get('minute')}`;
  const today = days.find((d) => d.dayOfWeek === dow);
  return Boolean(
    today &&
    !today.closed &&
    today.opens &&
    today.closes &&
    time >= today.opens &&
    time < today.closes,
  );
}
