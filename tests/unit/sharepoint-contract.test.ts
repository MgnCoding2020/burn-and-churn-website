import { describe, expect, it } from 'vitest';
import doc from '../../docs/contracts/sharepoint-lists.md?raw';
import contractJson from '../../docs/contracts/sharepoint-lists.json' with { type: 'json' };
import menu from '../../seed/menu.json' with { type: 'json' };
import { menuSeedRows } from '../../scripts/tenant/menu-seed-rows.mjs';

// The SharePoint contract (docs/contracts/sharepoint-lists.{md,json}): the JSON the
// set-up script reads must match the document people read, and its seed rows
// must pass the rules the sync will enforce.

interface Column {
  name: string;
  type: string;
  choices?: string[];
}
interface Row {
  [field: string]: string | number | boolean | undefined;
}
interface ListContract {
  name: string;
  columns: Column[];
  permissions: { read: string[]; edit: string[] };
  allowedTags?: string[];
  seedRows?: Row[];
}
const contract = contractJson as unknown as { site: { path: string }; lists: ListContract[] };
const list = (name: string) => contract.lists.find((l) => l.name === name)!;
const GROUPS = new Set([
  'grp-bc-all-staff',
  'grp-bc-baristas',
  'grp-bc-shift-leads',
  'grp-bc-managers',
  'grp-bc-owners',
]);

describe('contract JSON and document agree', () => {
  it('every list and column in the JSON is in the document, by internal name', () => {
    for (const l of contract.lists) {
      expect(doc, `list ${l.name}`).toMatch(new RegExp(`### \\d\\. ${l.name}:`));
      // The table cell holding the internal name, however Prettier pads it.
      for (const c of l.columns) {
        const cell = new RegExp(String.raw`\|\s*` + '`' + c.name + '`' + String.raw`\s*\|`);
        expect(doc, `${l.name}.${c.name}`).toMatch(cell);
      }
    }
    expect(doc).toContain(contract.site.path);
  });

  it('internal names are safe and unique per list; permissions name only Burn and Churn groups', () => {
    for (const l of contract.lists) {
      const names = l.columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const n of [l.name, ...names]) expect(n).toMatch(/^[A-Za-z][A-Za-z0-9]{1,31}$/);
      for (const g of [...l.permissions.read, ...l.permissions.edit])
        expect(GROUPS.has(g)).toBe(true);
    }
    // Schedule: shift leads and up only (Michael, 2026-11-10).
    expect(list('Schedule').permissions.read).toEqual([]);
    expect(list('Schedule').permissions.edit).not.toContain('grp-bc-baristas');
  });
});

describe('seed rows pass the sync rules', () => {
  const rows = menuSeedRows(menu) as Record<string, unknown>[];
  const choices = list('Menu').columns.find((c) => c.name === 'Category')!.choices!;

  it('every menu item maps to a valid Menu row', () => {
    expect(rows).toHaveLength(menu.items.length);
    expect(new Set(rows.map((r) => r.ItemId)).size).toBe(rows.length);
    for (const r of rows) {
      expect(choices).toContain(r.Category);
      expect(String(r.Description).length).toBeLessThanOrEqual(300);
      expect(String(r.Title).length).toBeLessThanOrEqual(60);
      const prices = ['PriceDouble', 'Price12', 'Price16', 'Price20'].filter(
        (p) => r[p] !== undefined,
      );
      expect(prices.length).toBeGreaterThan(0);
      for (const p of prices) {
        expect(r[p] as number).toBeGreaterThanOrEqual(0.5);
        expect(r[p] as number).toBeLessThanOrEqual(20);
      }
      // Espresso: a double shot only; everything else: sizes only (plan §10.1).
      if (r.ItemId === 'espresso') expect(prices).toEqual(['PriceDouble']);
      else expect(prices).not.toContain('PriceDouble');
      for (const tag of String(r.Tags).split(',')) expect(list('Menu').allowedTags).toContain(tag);
    }
  });

  it('store hours cover each day once with valid times; inventory links real drinks', () => {
    const hours = list('StoreHours').seedRows!;
    expect(new Set(hours.map((h) => h.DayOfWeek))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    for (const h of hours) {
      expect(h.Opens).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(h.Closes! > h.Opens!).toBe(true);
    }
    const ids = new Set(menu.items.map((i) => i.id));
    for (const s of list('Inventory').seedRows!) {
      expect(s.OnHand).toBeGreaterThanOrEqual(0);
      for (const id of String(s.MenuItems ?? '')
        .split(',')
        .filter(Boolean))
        expect(ids.has(id), id).toBe(true);
    }
  });
});
