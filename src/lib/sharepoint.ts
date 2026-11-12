import { z } from 'zod';
import seed from '../../seed/menu.json';
import type { ListItem } from './graph';
import { CATEGORY_IDS, parseMenu, type Menu } from './menu/schema';

/**
 * Validates SharePoint list rows against the contract (docs/contracts/sharepoint-lists.md;
 * ADR-0039) and turns the good ones into the shapes the site uses. A row that breaks a
 * rule is skipped and reported with its reason; the rest still publish. Nothing from
 * SharePoint is ever treated as HTML: every value is plain text, validated here.
 */

export interface Rejected {
  itemId: string;
  title: string;
  reason: string;
}

export interface ListResult<T> {
  data: T;
  read: number;
  published: number;
  rejected: Rejected[];
  /** False when the list mustn't replace the last good copy (e.g. a menu with no valid drinks). */
  publishable: boolean;
}

const ALLOWED_TAGS = ['hot', 'iced', 'dairy', 'vegan-option', 'caffeine-free', 'seasonal'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const plain = (max: number) => z.string().trim().min(1).max(max);
const optionalPlain = (max: number) =>
  z.preprocess(
    (v) => (v === null || v === '' ? undefined : v),
    z.string().trim().max(max).optional(),
  );
const optionalNumber = z.preprocess(
  (v) => (v === null || v === '' ? undefined : v),
  z.number().optional(),
);
/** A SharePoint date-only value ("2026-11-14T05:00:00Z") as YYYY-MM-DD. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'a date')
  .transform((v) => v.slice(0, 10));

function reasonOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid row';
  const field = issue.path.join('.');
  return field ? `${field}: ${issue.message}` : issue.message;
}

function validate<T>(
  items: ListItem[],
  schema: z.ZodType<T>,
): { good: { item: ListItem; value: T }[]; rejected: Rejected[] } {
  const good: { item: ListItem; value: T }[] = [];
  const rejected: Rejected[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item.fields);
    const title = String(item.fields.Title ?? '').slice(0, 80);
    if (parsed.success) good.push({ item, value: parsed.data });
    else rejected.push({ itemId: item.id, title, reason: reasonOf(parsed.error) });
  }
  return { good, rejected };
}

// ---------------------------------------------------------------- Menu

const dollars = z.number().min(0.5).max(20);

const MenuRow = z
  .object({
    Title: plain(60),
    ItemId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens'),
    Category: z.enum(CATEGORY_IDS),
    Description: plain(160),
    PriceDouble: optionalNumber.pipe(dollars.optional()),
    Price12: optionalNumber.pipe(dollars.optional()),
    Price16: optionalNumber.pipe(dollars.optional()),
    Price20: optionalNumber.pipe(dollars.optional()),
    Tags: optionalPlain(120),
    Active: z.boolean(),
    SortOrder: z.number().int().min(0).max(999),
  })
  .superRefine((row, ctx) => {
    const sizes = [row.Price12, row.Price16, row.Price20].filter((p) => p !== undefined).length;
    const double = row.PriceDouble !== undefined;
    // The site's menu rule (src/lib/menu/schema.ts): a double shot only, or all three sizes.
    if (double && sizes > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['PriceDouble'],
        message: 'a double shot or sizes, not both',
      });
    } else if (!double && sizes !== 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['Price12'],
        message: 'needs a double-shot price or all three sizes',
      });
    }
    for (const tag of (row.Tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)) {
      if (!ALLOWED_TAGS.includes(tag)) {
        ctx.addIssue({ code: 'custom', path: ['Tags'], message: `unknown tag "${tag}"` });
      }
    }
  });

const cents = (d: number) => Math.round(d * 100);

export function menuFromRows(items: ListItem[]): ListResult<Menu | null> {
  const { good, rejected } = validate(items, MenuRow);
  const seen = new Set<string>();
  const unique: (typeof good)[number][] = [];
  for (const g of good) {
    if (seen.has(g.value.ItemId)) {
      rejected.push({
        itemId: g.item.id,
        title: g.value.Title,
        reason: `ItemId: "${g.value.ItemId}" is used twice`,
      });
      continue;
    }
    seen.add(g.value.ItemId);
    unique.push(g);
  }
  const featured = new Map(seed.items.map((i) => [i.id, i.featured]));
  const order = (c: string) => CATEGORY_IDS.indexOf(c as (typeof CATEGORY_IDS)[number]);
  unique.sort(
    (a, b) =>
      order(a.value.Category) - order(b.value.Category) || a.value.SortOrder - b.value.SortOrder,
  );
  const seedShape = {
    currency: 'USD',
    fictional: true,
    price_unit: 'cents',
    categories: seed.categories,
    items: unique.map(({ value: r }) => ({
      id: r.ItemId,
      category: r.Category,
      name: r.Title,
      description: r.Description,
      prices:
        r.PriceDouble !== undefined
          ? { single: cents(r.PriceDouble) }
          : { '12oz': cents(r.Price12!), '16oz': cents(r.Price16!), '20oz': cents(r.Price20!) },
      featured: featured.get(r.ItemId) ?? false,
      iced: (r.Tags ?? '')
        .split(',')
        .map((t) => t.trim())
        .includes('iced'),
      available: r.Active,
    })),
  };
  if (unique.length === 0) {
    return { data: null, read: items.length, published: 0, rejected, publishable: false };
  }
  try {
    const menu = parseMenu(seedShape);
    return {
      data: menu,
      read: items.length,
      published: unique.length,
      rejected,
      publishable: true,
    };
  } catch (err) {
    rejected.push({
      itemId: '-',
      title: 'Menu',
      reason: `the menu as a whole is invalid: ${String(err).slice(0, 200)}`,
    });
    return { data: null, read: items.length, published: 0, rejected, publishable: false };
  }
}

// ---------------------------------------------------------------- Store hours

export interface StoreHoursDay {
  day: string;
  dayOfWeek: number;
  opens: string | null;
  closes: string | null;
  closed: boolean;
  note: string | null;
}

const HoursRow = z
  .object({
    Title: plain(20),
    DayOfWeek: z.number().int().min(1).max(7),
    Opens: optionalPlain(5),
    Closes: optionalPlain(5),
    Closed: z.boolean(),
    Note: optionalPlain(120),
  })
  .superRefine((row, ctx) => {
    if (row.Closed) return;
    if (!row.Opens || !TIME.test(row.Opens))
      ctx.addIssue({ code: 'custom', path: ['Opens'], message: 'HH:MM, 24-hour' });
    if (!row.Closes || !TIME.test(row.Closes))
      ctx.addIssue({ code: 'custom', path: ['Closes'], message: 'HH:MM, 24-hour' });
    if (row.Opens && row.Closes && row.Closes <= row.Opens)
      ctx.addIssue({ code: 'custom', path: ['Closes'], message: 'must be after Opens' });
  });

export function hoursFromRows(items: ListItem[]): ListResult<StoreHoursDay[]> {
  const { good, rejected } = validate(items, HoursRow);
  const byDay = new Map<number, StoreHoursDay>();
  for (const { item, value: r } of good) {
    if (byDay.has(r.DayOfWeek)) {
      rejected.push({
        itemId: item.id,
        title: r.Title,
        reason: `DayOfWeek: ${r.DayOfWeek} appears twice`,
      });
      continue;
    }
    byDay.set(r.DayOfWeek, {
      day: r.Title,
      dayOfWeek: r.DayOfWeek,
      opens: r.Closed ? null : (r.Opens ?? null),
      closes: r.Closed ? null : (r.Closes ?? null),
      closed: r.Closed,
      note: r.Note ?? null,
    });
  }
  const data = [...byDay.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  return {
    data,
    read: items.length,
    published: data.length,
    rejected,
    publishable: data.length > 0,
  };
}

// ---------------------------------------------------------------- Announcements

export interface Announcement {
  headline: string;
  body: string;
  audience: 'public' | 'staff';
  startsOn: string;
  endsOn: string | null;
}

const AnnouncementRow = z
  .object({
    Title: plain(80),
    Body: plain(500),
    Audience: z.enum(['public', 'staff']),
    StartsOn: dateOnly,
    EndsOn: z.preprocess((v) => (v === null || v === '' ? undefined : v), dateOnly.optional()),
  })
  .superRefine((row, ctx) => {
    if (row.EndsOn && row.EndsOn < row.StartsOn)
      ctx.addIssue({ code: 'custom', path: ['EndsOn'], message: 'must be on or after StartsOn' });
  });

export function announcementsFromRows(items: ListItem[]): ListResult<Announcement[]> {
  const { good, rejected } = validate(items, AnnouncementRow);
  const data = good.map(({ value: r }) => ({
    headline: r.Title,
    body: r.Body,
    audience: r.Audience,
    startsOn: r.StartsOn,
    endsOn: r.EndsOn ?? null,
  }));
  return { data, read: items.length, published: data.length, rejected, publishable: true };
}

// ---------------------------------------------------------------- Shift notes

export interface ShiftNote {
  summary: string;
  date: string;
  shift: 'open' | 'mid' | 'close';
  note: string;
  author: string | null;
}

const ShiftNoteRow = z.object({
  Title: plain(80),
  ShiftDate: dateOnly,
  Shift: z.enum(['open', 'mid', 'close']),
  Note: plain(1000),
});

export function shiftNotesFromRows(items: ListItem[]): ListResult<ShiftNote[]> {
  const { good, rejected } = validate(items, ShiftNoteRow);
  const data = good
    .map(({ item, value: r }) => ({
      summary: r.Title,
      date: r.ShiftDate,
      shift: r.Shift,
      note: r.Note,
      author: item.createdBy ?? null,
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { data, read: items.length, published: data.length, rejected, publishable: true };
}

// ---------------------------------------------------------------- Inventory

export interface InventoryItem {
  supply: string;
  unit: string;
  parLevel: number;
  onHand: number;
  menuItems: string[];
  low: boolean;
}

const InventoryRow = z.object({
  Title: plain(60),
  Unit: plain(20),
  ParLevel: z.number().int().min(0).max(999),
  OnHand: z.number().int().min(0).max(9999),
  MenuItems: optionalPlain(200),
});

export function inventoryFromRows(items: ListItem[]): ListResult<InventoryItem[]> {
  const { good, rejected } = validate(items, InventoryRow);
  const data = good.map(({ value: r }) => ({
    supply: r.Title,
    unit: r.Unit,
    parLevel: r.ParLevel,
    onHand: r.OnHand,
    menuItems: (r.MenuItems ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    low: r.OnHand <= r.ParLevel,
  }));
  return { data, read: items.length, published: data.length, rejected, publishable: true };
}

/** The lists the sync publishes, in order, with their converters. Schedule waits for T-SH-01. */
export const SYNCED_LISTS = {
  Menu: menuFromRows,
  StoreHours: hoursFromRows,
  Announcements: announcementsFromRows,
  ShiftNotes: shiftNotesFromRows,
  Inventory: inventoryFromRows,
} as const;
export type SyncedList = keyof typeof SYNCED_LISTS;
