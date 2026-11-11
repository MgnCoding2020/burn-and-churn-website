import { describe, expect, it } from 'vitest';
import contract from '../../docs/contracts/sharepoint-lists.json';
import { menuSeedRows } from '../../scripts/tenant/menu-seed-rows.mjs';
import seed from '../../seed/menu.json';
import type { ListItem } from '../../src/lib/graph';
import { parseMenu } from '../../src/lib/menu/schema';
import {
  announcementsFromRows,
  hoursFromRows,
  inventoryFromRows,
  menuFromRows,
  shiftNotesFromRows,
} from '../../src/lib/sharepoint';

// SharePoint rows → the shapes the site uses (ADR-0039): good rows publish, bad
// rows are skipped with a reason, and the contract's own seed rows all pass.

const asItems = (rows: Record<string, unknown>[]): ListItem[] =>
  rows.map((fields, i) => ({ id: String(i + 1), fields }));

const seedRowsOf = (name: string) =>
  contract.lists.find((l) => l.name === name)!.seedRows as unknown as Record<string, unknown>[];

const menuRows = (): Record<string, unknown>[] => menuSeedRows(seed);

describe('menuFromRows', () => {
  it('turns the seeded Menu list back into exactly the menu the site has today', () => {
    const result = menuFromRows(asItems(menuRows()));
    expect(result.rejected).toEqual([]);
    expect(result.publishable).toBe(true);
    expect(result.published).toBe(seed.items.length);
    expect(result.data!.categories).toEqual(parseMenu(seed).categories);
  });

  it('skips a bad row with its reason and publishes the rest', () => {
    const rows = menuRows();
    rows[0] = { ...rows[0], Price12: 4.5 }; // espresso: a double shot and a size
    rows[1] = { ...rows[1], Category: 'pastries' };
    rows[2] = { ...rows[2], Tags: 'hot,<script>' };
    rows[3] = { ...rows[3], Description: 'x'.repeat(161) };
    const result = menuFromRows(asItems(rows));
    expect(result.published).toBe(seed.items.length - 4);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'PriceDouble: a double shot or sizes, not both',
      expect.stringMatching(/^Category: /),
      'Tags: unknown tag "<script>"',
      expect.stringMatching(/^Description: /),
    ]);
    expect(result.rejected[0]).toMatchObject({ itemId: '1', title: rows[0]!.Title });
  });

  it('needs all three sizes when there is no double-shot price', () => {
    const rows = menuRows().filter((r) => r.Price12 !== undefined);
    delete rows[0]!.Price20;
    const result = menuFromRows(asItems(rows));
    expect(result.rejected[0]!.reason).toBe(
      'Price12: needs a double-shot price or all three sizes',
    );
  });

  it('rejects the second row that reuses an Item ID', () => {
    const rows = menuRows();
    rows.push({ ...rows[0], Title: 'Copy' });
    const result = menuFromRows(asItems(rows));
    expect(result.rejected).toEqual([
      {
        itemId: String(rows.length),
        title: 'Copy',
        reason: `ItemId: "${rows[0]!.ItemId}" is used twice`,
      },
    ]);
  });

  it('turns prices in dollars into whole cents and Active into availability', () => {
    const rows = menuRows().map((r) =>
      r.ItemId === 'americano' ? { ...r, Price12: 3.1, Active: false } : r,
    );
    const item = menuFromRows(asItems(rows)).data!.items.find((i) => i.id === 'americano')!;
    expect(item.variants[0]).toMatchObject({ id: '12oz', priceCents: 310, available: false });
    expect(item.available).toBe(false);
  });

  it("won't publish a menu with no valid drinks", () => {
    const result = menuFromRows(asItems([{ Title: 'Broken' }]));
    expect(result.publishable).toBe(false);
    expect(result.data).toBeNull();
  });
});

describe('hoursFromRows', () => {
  it('accepts the contract seed rows', () => {
    const result = hoursFromRows(asItems(seedRowsOf('StoreHours')));
    expect(result.rejected).toEqual([]);
    expect(result.data).toHaveLength(7);
    expect(result.data[0]).toMatchObject({ day: 'Monday', dayOfWeek: 1, closed: false });
  });

  it('rejects bad times, closing before opening, and a repeated day', () => {
    const result = hoursFromRows(
      asItems([
        { Title: 'Monday', DayOfWeek: 1, Opens: '7am', Closes: '18:00', Closed: false },
        { Title: 'Tuesday', DayOfWeek: 2, Opens: '18:00', Closes: '07:00', Closed: false },
        { Title: 'Wednesday', DayOfWeek: 3, Closed: true },
        { Title: 'Wed again', DayOfWeek: 3, Closed: true },
      ]),
    );
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'Opens: HH:MM, 24-hour',
      'Closes: must be after Opens',
      'DayOfWeek: 3 appears twice',
    ]);
    expect(result.data).toEqual([
      { day: 'Wednesday', dayOfWeek: 3, opens: null, closes: null, closed: true, note: null },
    ]);
  });
});

describe('announcementsFromRows', () => {
  it('keeps dates only and checks the audience and the date order', () => {
    const result = announcementsFromRows(
      asItems([
        {
          Title: 'Maple is back',
          Body: 'Maple Smoke returns this weekend.',
          Audience: 'public',
          StartsOn: '2026-11-14T05:00:00Z',
          EndsOn: null,
        },
        { Title: 'Bad', Body: 'x', Audience: 'everyone', StartsOn: '2026-11-14T05:00:00Z' },
        {
          Title: 'Backwards',
          Body: 'x',
          Audience: 'staff',
          StartsOn: '2026-11-14T05:00:00Z',
          EndsOn: '2026-11-13T05:00:00Z',
        },
      ]),
    );
    expect(result.data).toEqual([
      {
        headline: 'Maple is back',
        body: 'Maple Smoke returns this weekend.',
        audience: 'public',
        startsOn: '2026-11-14',
        endsOn: null,
      },
    ]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/^Audience: /),
      'EndsOn: must be on or after StartsOn',
    ]);
  });
});

describe('shiftNotesFromRows', () => {
  it('takes the author from SharePoint and sorts newest first', () => {
    const result = shiftNotesFromRows([
      {
        id: '1',
        fields: { Title: 'Old', ShiftDate: '2026-11-14T05:00:00Z', Shift: 'open', Note: 'a' },
        createdBy: 'Test Lead',
      },
      {
        id: '2',
        fields: { Title: 'New', ShiftDate: '2026-11-15T05:00:00Z', Shift: 'close', Note: 'b' },
      },
      { id: '3', fields: { Title: 'Bad', ShiftDate: '2026-11-15', Shift: 'night', Note: 'c' } },
    ]);
    expect(result.data.map((n) => [n.summary, n.date, n.author])).toEqual([
      ['New', '2026-11-15', null],
      ['Old', '2026-11-14', 'Test Lead'],
    ]);
    expect(result.rejected).toHaveLength(1);
  });
});

describe('inventoryFromRows', () => {
  it('accepts the contract seed rows and flags stock at or under par', () => {
    const rows = seedRowsOf('Inventory');
    const result = inventoryFromRows(asItems(rows));
    expect(result.rejected).toEqual([]);
    expect(result.data.every((i) => !i.low)).toBe(true);
    const low = inventoryFromRows(asItems([{ ...rows[0], OnHand: 5 }])).data[0]!;
    expect(low).toMatchObject({ supply: 'House espresso beans', low: true });
    expect(low.menuItems).toContain('espresso');
  });

  it('rejects negative or fractional counts', () => {
    const result = inventoryFromRows(
      asItems([
        { Title: 'Milk', Unit: 'gallon', ParLevel: 2, OnHand: -1 },
        { Title: 'Oat', Unit: 'carton', ParLevel: 2.5, OnHand: 1 },
      ]),
    );
    expect(result.data).toEqual([]);
    expect(result.rejected.map((r) => r.reason.split(':')[0])).toEqual(['OnHand', 'ParLevel']);
  });
});
